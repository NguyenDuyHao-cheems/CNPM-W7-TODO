#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <errno.h>
#include <pthread.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "cJSON.h"

#define DEFAULT_PORT 8080
#define BUFFER_SIZE 65536
#define TASKS_FILE "tasks.json"

static volatile sig_atomic_t server_running = 1;
static int server_socket_fd = -1;

static cJSON *tasks_root = NULL;
static pthread_mutex_t tasks_mutex = PTHREAD_MUTEX_INITIALIZER;

static void handle_sigint(int sig) {
    (void)sig;
    server_running = 0;
    if (server_socket_fd >= 0) {
        close(server_socket_fd);
        server_socket_fd = -1;
    }
}

/* Helper: Read entire file into heap buffer */
static char *read_file_to_string(const char *path, long *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    fseek(f, 0, SEEK_END);
    long length = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (length < 0) {
        fclose(f);
        return NULL;
    }

    char *buffer = (char *)malloc(length + 1);
    if (!buffer) {
        fclose(f);
        return NULL;
    }

    size_t read_bytes = fread(buffer, 1, length, f);
    buffer[read_bytes] = '\0';
    fclose(f);

    if (out_len) *out_len = (long)read_bytes;
    return buffer;
}

/* Persistence: Save tasks to tasks.json atomically */
static bool save_tasks_to_disk(void) {
    if (!tasks_root) return false;

    char *rendered = cJSON_Print(tasks_root);
    if (!rendered) return false;

    char tmp_file[64];
    snprintf(tmp_file, sizeof(tmp_file), "%s.tmp", TASKS_FILE);

    FILE *f = fopen(tmp_file, "wb");
    if (!f) {
        free(rendered);
        return false;
    }

    size_t len = strlen(rendered);
    if (fwrite(rendered, 1, len, f) != len) {
        fclose(f);
        unlink(tmp_file);
        free(rendered);
        return false;
    }
    fflush(f);
    fclose(f);

    if (rename(tmp_file, TASKS_FILE) != 0) {
        unlink(tmp_file);
        free(rendered);
        return false;
    }

    free(rendered);
    return true;
}

/* Persistence: Load tasks from tasks.json or init if missing */
static void init_tasks_storage(void) {
    pthread_mutex_lock(&tasks_mutex);
    long len = 0;
    char *content = read_file_to_string(TASKS_FILE, &len);

    if (content && len > 0) {
        tasks_root = cJSON_Parse(content);
        free(content);
        if (!tasks_root || !cJSON_IsArray(tasks_root)) {
            if (tasks_root) cJSON_Delete(tasks_root);
            tasks_root = cJSON_CreateArray();
            save_tasks_to_disk();
        }
    } else {
        if (content) free(content);
        tasks_root = cJSON_CreateArray();
        save_tasks_to_disk();
    }
    pthread_mutex_unlock(&tasks_mutex);
}

/* Find max ID among current tasks */
static int get_next_task_id(void) {
    int max_id = 0;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, tasks_root) {
        cJSON *id_obj = cJSON_GetObjectItemCaseSensitive(item, "id");
        if (id_obj && cJSON_IsNumber(id_obj)) {
            if (id_obj->valueint > max_id) {
                max_id = id_obj->valueint;
            }
        }
    }
    return max_id + 1;
}

/* Send HTTP Response */
static void send_response(int client_fd, int status_code, const char *status_text,
                          const char *content_type, const char *body, size_t body_len) {
    char header[1024];
    int header_len = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Connection: close\r\n"
        "\r\n",
        status_code, status_text, content_type, body_len);

    send(client_fd, header, header_len, 0);
    if (body && body_len > 0) {
        send(client_fd, body, body_len, 0);
    }
}

static void send_json_response(int client_fd, int status_code, const char *status_text, const char *json_str) {
    size_t len = json_str ? strlen(json_str) : 0;
    send_response(client_fd, status_code, status_text, "application/json; charset=utf-8", json_str, len);
}

static void send_error(int client_fd, int status_code, const char *status_text, const char *msg) {
    char json[512];
    snprintf(json, sizeof(json), "{\"error\":\"%s\",\"code\":%d}", msg, status_code);
    send_json_response(client_fd, status_code, status_text, json);
}

/* Serve static files from public/ directory */
static void serve_static_file(int client_fd, const char *filepath, const char *content_type) {
    long file_len = 0;
    char *data = read_file_to_string(filepath, &file_len);
    if (!data) {
        send_error(client_fd, 404, "Not Found", "File not found");
        return;
    }
    send_response(client_fd, 200, "OK", content_type, data, (size_t)file_len);
    free(data);
}

/* Route handlers */
static void handle_get_tasks(int client_fd) {
    pthread_mutex_lock(&tasks_mutex);
    char *json_str = cJSON_Print(tasks_root);
    pthread_mutex_unlock(&tasks_mutex);

    if (!json_str) {
        send_error(client_fd, 500, "Internal Server Error", "Failed to render tasks JSON");
        return;
    }

    send_json_response(client_fd, 200, "OK", json_str);
    free(json_str);
}

static void handle_post_task(int client_fd, const char *body) {
    if (!body || strlen(body) == 0) {
        send_error(client_fd, 400, "Bad Request", "Missing request body");
        return;
    }

    cJSON *payload = cJSON_Parse(body);
    if (!payload) {
        send_error(client_fd, 400, "Bad Request", "Invalid JSON body");
        return;
    }

    cJSON *title_obj = cJSON_GetObjectItemCaseSensitive(payload, "title");
    if (!title_obj || !cJSON_IsString(title_obj) || strlen(title_obj->valuestring) == 0) {
        cJSON_Delete(payload);
        send_error(client_fd, 400, "Bad Request", "Task 'title' is required and must not be empty");
        return;
    }

    pthread_mutex_lock(&tasks_mutex);
    int next_id = get_next_task_id();

    cJSON *task = cJSON_CreateObject();
    cJSON_AddNumberToObject(task, "id", next_id);
    cJSON_AddStringToObject(task, "title", title_obj->valuestring);
    cJSON_AddBoolToObject(task, "completed", false);
    cJSON_AddNumberToObject(task, "created_at", (double)time(NULL));

    cJSON_AddItemToArray(tasks_root, task);
    save_tasks_to_disk();

    char *task_str = cJSON_Print(task);
    pthread_mutex_unlock(&tasks_mutex);

    cJSON_Delete(payload);

    send_json_response(client_fd, 201, "Created", task_str);
    free(task_str);
}

static void handle_update_task(int client_fd, int target_id, const char *body) {
    if (!body || strlen(body) == 0) {
        send_error(client_fd, 400, "Bad Request", "Missing request body");
        return;
    }

    cJSON *payload = cJSON_Parse(body);
    if (!payload) {
        send_error(client_fd, 400, "Bad Request", "Invalid JSON body");
        return;
    }

    pthread_mutex_lock(&tasks_mutex);
    cJSON *target_task = NULL;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, tasks_root) {
        cJSON *id_obj = cJSON_GetObjectItemCaseSensitive(item, "id");
        if (id_obj && cJSON_IsNumber(id_obj) && id_obj->valueint == target_id) {
            target_task = item;
            break;
        }
    }

    if (!target_task) {
        pthread_mutex_unlock(&tasks_mutex);
        cJSON_Delete(payload);
        send_error(client_fd, 404, "Not Found", "Task not found");
        return;
    }

    cJSON *completed_obj = cJSON_GetObjectItemCaseSensitive(payload, "completed");
    if (completed_obj && cJSON_IsBool(completed_obj)) {
        cJSON_ReplaceItemInObject(target_task, "completed", cJSON_CreateBool(cJSON_IsTrue(completed_obj)));
    }

    cJSON *title_obj = cJSON_GetObjectItemCaseSensitive(payload, "title");
    if (title_obj && cJSON_IsString(title_obj) && strlen(title_obj->valuestring) > 0) {
        cJSON_ReplaceItemInObject(target_task, "title", cJSON_CreateString(title_obj->valuestring));
    }

    save_tasks_to_disk();
    char *updated_str = cJSON_Print(target_task);
    pthread_mutex_unlock(&tasks_mutex);

    cJSON_Delete(payload);

    send_json_response(client_fd, 200, "OK", updated_str);
    free(updated_str);
}

static void handle_delete_task(int client_fd, int target_id) {
    pthread_mutex_lock(&tasks_mutex);
    int target_idx = -1;
    int idx = 0;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, tasks_root) {
        cJSON *id_obj = cJSON_GetObjectItemCaseSensitive(item, "id");
        if (id_obj && cJSON_IsNumber(id_obj) && id_obj->valueint == target_id) {
            target_idx = idx;
            break;
        }
        idx++;
    }

    if (target_idx < 0) {
        pthread_mutex_unlock(&tasks_mutex);
        send_error(client_fd, 404, "Not Found", "Task not found");
        return;
    }

    cJSON_DeleteItemFromArray(tasks_root, target_idx);
    save_tasks_to_disk();
    pthread_mutex_unlock(&tasks_mutex);

    char resp[256];
    snprintf(resp, sizeof(resp), "{\"success\":true,\"deleted_id\":%d}", target_id);
    send_json_response(client_fd, 200, "OK", resp);
}

/* Client request dispatcher */
static void *handle_client(void *arg) {
    int client_fd = (intptr_t)arg;
    char buffer[BUFFER_SIZE];
    ssize_t bytes_read = recv(client_fd, buffer, sizeof(buffer) - 1, 0);

    if (bytes_read <= 0) {
        close(client_fd);
        return NULL;
    }
    buffer[bytes_read] = '\0';

    char method[16] = {0};
    char path[512] = {0};
    char version[16] = {0};

    if (sscanf(buffer, "%15s %511s %15s", method, path, version) < 2) {
        send_error(client_fd, 400, "Bad Request", "Malformed request line");
        close(client_fd);
        return NULL;
    }

    /* Strip query string from path for routing */
    char *query = strchr(path, '?');
    if (query) *query = '\0';

    /* Locate body */
    char *body = strstr(buffer, "\r\n\r\n");
    if (body) {
        body += 4;
    }

    /* If Content-Length > body read so far, read remainder */
    char *cl_header = strcasestr(buffer, "Content-Length:");
    if (cl_header) {
        long content_length = strtol(cl_header + 15, NULL, 10);
        long current_body_len = body ? (bytes_read - (body - buffer)) : 0;
        if (content_length > current_body_len && content_length < BUFFER_SIZE) {
            ssize_t remaining = content_length - current_body_len;
            ssize_t extra = recv(client_fd, buffer + bytes_read, remaining, 0);
            if (extra > 0) {
                bytes_read += extra;
                buffer[bytes_read] = '\0';
            }
        }
    }

    /* Handle OPTIONS for CORS */
    if (strcmp(method, "OPTIONS") == 0) {
        send_response(client_fd, 204, "No Content", "text/plain", "", 0);
        close(client_fd);
        return NULL;
    }

    /* API routes */
    if (strncmp(path, "/api/tasks", 10) == 0) {
        char *id_part = path + 10;
        if (*id_part == '/') id_part++;

        if (strlen(id_part) == 0) {
            if (strcmp(method, "GET") == 0) {
                handle_get_tasks(client_fd);
            } else if (strcmp(method, "POST") == 0) {
                handle_post_task(client_fd, body);
            } else {
                send_error(client_fd, 405, "Method Not Allowed", "Method not supported on /api/tasks");
            }
        } else {
            int task_id = atoi(id_part);
            if (task_id <= 0) {
                send_error(client_fd, 400, "Bad Request", "Invalid task ID");
            } else if (strcmp(method, "PUT") == 0 || strcmp(method, "PATCH") == 0) {
                handle_update_task(client_fd, task_id, body);
            } else if (strcmp(method, "DELETE") == 0) {
                handle_delete_task(client_fd, task_id);
            } else if (strcmp(method, "GET") == 0) {
                /* Optional get single task */
                pthread_mutex_lock(&tasks_mutex);
                cJSON *target = NULL;
                cJSON *it = NULL;
                cJSON_ArrayForEach(it, tasks_root) {
                    cJSON *id_obj = cJSON_GetObjectItemCaseSensitive(it, "id");
                    if (id_obj && id_obj->valueint == task_id) {
                        target = it;
                        break;
                    }
                }
                char *res = target ? cJSON_Print(target) : NULL;
                pthread_mutex_unlock(&tasks_mutex);
                if (target && res) {
                    send_json_response(client_fd, 200, "OK", res);
                    free(res);
                } else {
                    send_error(client_fd, 404, "Not Found", "Task not found");
                }
            } else {
                send_error(client_fd, 405, "Method Not Allowed", "Method not supported on /api/tasks/:id");
            }
        }
        close(client_fd);
        return NULL;
    }

    /* Static files */
    if (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0) {
        serve_static_file(client_fd, "public/index.html", "text/html; charset=utf-8");
    } else if (strcmp(path, "/style.css") == 0 || strcmp(path, "/public/style.css") == 0) {
        serve_static_file(client_fd, "public/style.css", "text/css; charset=utf-8");
    } else if (strcmp(path, "/app.js") == 0 || strcmp(path, "/public/app.js") == 0) {
        serve_static_file(client_fd, "public/app.js", "application/javascript; charset=utf-8");
    } else if (strcmp(path, "/tasks.json") == 0) {
        serve_static_file(client_fd, TASKS_FILE, "application/json; charset=utf-8");
    } else {
        send_error(client_fd, 404, "Not Found", "Route not found");
    }

    close(client_fd);
    return NULL;
}

int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;
    if (argc >= 2) {
        port = atoi(argv[1]);
        if (port <= 0 || port > 65535) port = DEFAULT_PORT;
    }

    signal(SIGINT, handle_sigint);
    signal(SIGTERM, handle_sigint);
    signal(SIGPIPE, SIG_IGN);

    init_tasks_storage();

    server_socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_socket_fd < 0) {
        perror("Failed to create socket");
        return 1;
    }

    int opt = 1;
    if (setsockopt(server_socket_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_REUSEADDR failed");
    }

    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(port);

    if (bind(server_socket_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        perror("Socket bind failed");
        close(server_socket_fd);
        return 1;
    }

    if (listen(server_socket_fd, 64) < 0) {
        perror("Socket listen failed");
        close(server_socket_fd);
        return 1;
    }

    printf("===================================================\n");
    printf(" CNPM-W7 Task Manager (Version 1 - Local C Backend)\n");
    printf(" Server listening at: http://localhost:%d\n", port);
    printf(" Data persistence:    %s\n", TASKS_FILE);
    printf(" Press Ctrl+C to terminate cleanly.\n");
    printf("===================================================\n");
    fflush(stdout);

    while (server_running) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(server_socket_fd, (struct sockaddr *)&client_addr, &client_len);

        if (client_fd < 0) {
            if (!server_running) break;
            continue;
        }

        pthread_t thread;
        if (pthread_create(&thread, NULL, handle_client, (void *)(intptr_t)client_fd) == 0) {
            pthread_detach(thread);
        } else {
            close(client_fd);
        }
    }

    printf("\nShutting down server cleanly...\n");
    if (server_socket_fd >= 0) {
        close(server_socket_fd);
    }

    pthread_mutex_lock(&tasks_mutex);
    if (tasks_root) {
        save_tasks_to_disk();
        cJSON_Delete(tasks_root);
        tasks_root = NULL;
    }
    pthread_mutex_unlock(&tasks_mutex);

    printf("Server stopped.\n");
    return 0;
}
