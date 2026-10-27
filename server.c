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
#include "task_service.h"
#include "event_broadcast.h"

#define DEFAULT_PORT 8080
#define BUFFER_SIZE 65536
#define TASKS_DB "tasks.db"
#define TASKS_JSON_MIGRATION "tasks.json"

static volatile sig_atomic_t server_running = 1;
static int server_socket_fd = -1;

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

/* Helper: URL-decode a query-string value (simple, in-place) */
static void url_decode(char *dst, size_t dst_size, const char *src) {
    size_t out = 0;
    for (size_t i = 0; src[i] && out + 1 < dst_size; i++) {
        if (src[i] == '%' && src[i+1] && src[i+2]) {
            char hex[3] = { src[i+1], src[i+2], '\0' };
            dst[out++] = (char)strtol(hex, NULL, 16);
            i += 2;
        } else if (src[i] == '+') {
            dst[out++] = ' ';
        } else {
            dst[out++] = src[i];
        }
    }
    dst[out] = '\0';
}

/* Helper: Extract value of named query parameter from raw query string */
static void get_query_param(const char *query, const char *param, char *out, size_t out_size) {
    out[0] = '\0';
    if (!query || !param) return;

    size_t param_len = strlen(param);
    const char *p = query;
    while (*p) {
        if (strncmp(p, param, param_len) == 0 && p[param_len] == '=') {
            const char *val_start = p + param_len + 1;
            const char *val_end   = strchr(val_start, '&');
            size_t val_len = val_end ? (size_t)(val_end - val_start) : strlen(val_start);
            char raw[512] = {0};
            if (val_len >= sizeof(raw)) val_len = sizeof(raw) - 1;
            memcpy(raw, val_start, val_len);
            raw[val_len] = '\0';
            url_decode(out, out_size, raw);
            return;
        }
        /* Advance to next param */
        const char *next = strchr(p, '&');
        if (!next) break;
        p = next + 1;
    }
}

/* Send HTTP Response */
static void send_response(int client_fd, int status_code, const char *status_text,
                          const char *content_type, const char *body, size_t body_len) {
    char header[1024];
    int header_len = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Cache-Control: no-cache, no-store, must-revalidate\r\n"
        "Pragma: no-cache\r\n"
        "Expires: 0\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, ngrok-skip-browser-warning\r\n"
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

/* ===================================================================
 * SSE Handler — long-lived connection: GET /api/events
 * =================================================================== */

typedef struct {
    int  client_fd;
    char client_name[256];
} sse_thread_args_t;

static void *handle_sse_thread(void *arg) {
    sse_thread_args_t *a = (sse_thread_args_t *)arg;
    int  fd          = a->client_fd;
    char name[256];
    strncpy(name, a->client_name, sizeof(name) - 1);
    name[sizeof(name) - 1] = '\0';
    free(a);

    /* Send SSE HTTP headers */
    const char *headers =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Headers: Content-Type, ngrok-skip-browser-warning\r\n"
        "\r\n";
    if (send(fd, headers, strlen(headers), 0) < 0) {
        close(fd);
        return NULL;
    }

    /* Register with broadcast system */
    int client_id = broadcast_add_client(fd, name);
    if (client_id < 0) {
        /* Too many clients */
        const char *err = "event: error\ndata: {\"error\":\"Too many clients\"}\n\n";
        send(fd, err, strlen(err), 0);
        close(fd);
        return NULL;
    }

    printf("[SSE] Client '%s' connected (id=%d), total=%d\n",
           name, client_id, broadcast_get_client_count());
    fflush(stdout);

    /* Announce arrival to all other clients */
    {
        cJSON *evt = cJSON_CreateObject();
        cJSON_AddStringToObject(evt, "client_name", name);
        cJSON_AddNumberToObject(evt, "online_count", broadcast_get_client_count());
        cJSON *list = broadcast_get_client_list();
        cJSON_AddItemToObject(evt, "clients", list);
        char *js = cJSON_PrintUnformatted(evt);
        cJSON_Delete(evt);
        if (js) {
            broadcast_event(EVENT_CLIENT_JOINED, js);
            free(js);
        }
    }

    /* Keep the connection open — send a heartbeat comment every 15s
     * so proxies/browsers don't time it out, and detect disconnects. */
    while (broadcast_client_alive(client_id)) {
        sleep(15);
        if (!broadcast_client_alive(client_id)) break;
        /* SSE comment (no event dispatch on client) */
        const char *hb = ": heartbeat\n\n";
        if (send(fd, hb, strlen(hb), MSG_NOSIGNAL) < 0) break;
    }

    /* Cleanup */
    broadcast_remove_client(client_id);

    printf("[SSE] Client '%s' left (id=%d), total=%d\n",
           name, client_id, broadcast_get_client_count());
    fflush(stdout);

    /* Announce departure */
    {
        cJSON *evt = cJSON_CreateObject();
        cJSON_AddStringToObject(evt, "client_name", name);
        cJSON_AddNumberToObject(evt, "online_count", broadcast_get_client_count());
        cJSON *list = broadcast_get_client_list();
        cJSON_AddItemToObject(evt, "clients", list);
        char *js = cJSON_PrintUnformatted(evt);
        cJSON_Delete(evt);
        if (js) {
            broadcast_event(EVENT_CLIENT_LEFT, js);
            free(js);
        }
    }

    return NULL;
}

/* ===================================================================
 * REST Route Handlers (Presentation Layer — delegates to Service)
 * =================================================================== */

static void handle_get_tasks(int client_fd) {
    cJSON *tasks = task_service_get_all();
    if (!tasks) {
        send_error(client_fd, 500, "Internal Server Error", "Không thể lấy danh sách công việc");
        return;
    }

    char *json_str = cJSON_Print(tasks);
    cJSON_Delete(tasks);

    if (!json_str) {
        send_error(client_fd, 500, "Internal Server Error", "Lỗi format JSON");
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
    const char *title = (title_obj && cJSON_IsString(title_obj)) ? title_obj->valuestring : NULL;

    char err_buf[256] = {0};
    cJSON *new_task = task_service_create(title, err_buf, sizeof(err_buf));
    cJSON_Delete(payload);

    if (!new_task) {
        send_error(client_fd, 400, "Bad Request", strlen(err_buf) > 0 ? err_buf : "Lỗi tạo công việc");
        return;
    }

    char *task_str = cJSON_PrintUnformatted(new_task);
    cJSON_Delete(new_task);

    send_json_response(client_fd, 201, "Created", task_str);

    /* V3.5: Broadcast real-time event to all SSE clients */
    broadcast_event(EVENT_TASK_CREATED, task_str);

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

    bool has_completed = false;
    bool completed_val = false;
    cJSON *completed_obj = cJSON_GetObjectItemCaseSensitive(payload, "completed");
    if (completed_obj && cJSON_IsBool(completed_obj)) {
        has_completed = true;
        completed_val = cJSON_IsTrue(completed_obj);
    }

    const char *new_title = NULL;
    cJSON *title_obj = cJSON_GetObjectItemCaseSensitive(payload, "title");
    if (title_obj && cJSON_IsString(title_obj)) {
        new_title = title_obj->valuestring;
    }

    char err_buf[256] = {0};
    cJSON *updated_task = task_service_update(target_id,
                                             has_completed ? &completed_val : NULL,
                                             new_title,
                                             err_buf, sizeof(err_buf));
    cJSON_Delete(payload);

    if (!updated_task) {
        send_error(client_fd, 404, "Not Found", strlen(err_buf) > 0 ? err_buf : "Công việc không tồn tại");
        return;
    }

    char *updated_str = cJSON_PrintUnformatted(updated_task);
    cJSON_Delete(updated_task);

    send_json_response(client_fd, 200, "OK", updated_str);

    /* V3.5: Broadcast real-time event to all SSE clients */
    broadcast_event(EVENT_TASK_UPDATED, updated_str);

    free(updated_str);
}

static void handle_delete_task(int client_fd, int target_id) {
    char err_buf[256] = {0};
    if (!task_service_delete(target_id, err_buf, sizeof(err_buf))) {
        send_error(client_fd, 404, "Not Found", strlen(err_buf) > 0 ? err_buf : "Công việc không tồn tại");
        return;
    }

    char resp[256];
    snprintf(resp, sizeof(resp), "{\"success\":true,\"deleted_id\":%d}", target_id);
    send_json_response(client_fd, 200, "OK", resp);

    /* V3.5: Broadcast real-time event to all SSE clients */
    broadcast_event(EVENT_TASK_DELETED, resp);
}

/* ===================================================================
 * Client Request Dispatcher
 * =================================================================== */

static void *handle_client(void *arg) {
    int client_fd = (intptr_t)arg;
    char buffer[BUFFER_SIZE];
    ssize_t bytes_read = recv(client_fd, buffer, sizeof(buffer) - 1, 0);

    if (bytes_read <= 0) {
        close(client_fd);
        return NULL;
    }
    buffer[bytes_read] = '\0';

    char method[16]  = {0};
    char path[512]   = {0};
    char version[16] = {0};

    if (sscanf(buffer, "%15s %511s %15s", method, path, version) < 2) {
        send_error(client_fd, 400, "Bad Request", "Malformed request line");
        close(client_fd);
        return NULL;
    }

    /* Split path from query string */
    char query_string[512] = {0};
    char *q = strchr(path, '?');
    if (q) {
        strncpy(query_string, q + 1, sizeof(query_string) - 1);
        *q = '\0';
    }

    char *body = strstr(buffer, "\r\n\r\n");
    if (body) body += 4;

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

    /* OPTIONS preflight */
    if (strcmp(method, "OPTIONS") == 0) {
        send_response(client_fd, 204, "No Content", "text/plain", "", 0);
        close(client_fd);
        return NULL;
    }

    /* -------------------------------------------------------------------
     * API routes
     * ------------------------------------------------------------------- */

    /* V3.5: SSE real-time event stream */
    if (strcmp(path, "/api/events") == 0 && strcmp(method, "GET") == 0) {
        char client_name[256] = {0};
        get_query_param(query_string, "name", client_name, sizeof(client_name));
        if (client_name[0] == '\0') {
            snprintf(client_name, sizeof(client_name), "Client #%ld", (long)time(NULL) % 10000);
        }

        sse_thread_args_t *args = malloc(sizeof(sse_thread_args_t));
        if (!args) {
            send_error(client_fd, 500, "Internal Server Error", "Out of memory");
            close(client_fd);
            return NULL;
        }
        args->client_fd = client_fd;
        strncpy(args->client_name, client_name, sizeof(args->client_name) - 1);
        args->client_name[sizeof(args->client_name) - 1] = '\0';

        pthread_t sse_thread;
        if (pthread_create(&sse_thread, NULL, handle_sse_thread, args) == 0) {
            pthread_detach(sse_thread);
        } else {
            free(args);
            send_error(client_fd, 500, "Internal Server Error", "Cannot create SSE thread");
            close(client_fd);
        }
        /* DO NOT close client_fd here — the SSE thread owns it */
        return NULL;
    }

    /* V3.5: Online client list */
    if (strcmp(path, "/api/clients") == 0 && strcmp(method, "GET") == 0) {
        cJSON *wrapper = cJSON_CreateObject();
        cJSON *list = broadcast_get_client_list();
        cJSON_AddItemToObject(wrapper, "clients", list);
        cJSON_AddNumberToObject(wrapper, "online_count", broadcast_get_client_count());
        char *js = cJSON_Print(wrapper);
        cJSON_Delete(wrapper);
        send_json_response(client_fd, 200, "OK", js);
        free(js);
        close(client_fd);
        return NULL;
    }

    /* Architecture info (updated to V4) */
    if (strcmp(path, "/api/info") == 0) {
        int count   = task_service_count();
        int online  = broadcast_get_client_count();
        char info_json[768];
        snprintf(info_json, sizeof(info_json),
            "{\"version\":\"V4\","
            "\"architecture\":\"N-Layer (Presentation, Service, SQLite Repository) + SSE + WebRTC DataChannel (P2P Fallback)\","
            "\"storage\":\"tasks.db (SQLite3) / Local In-Memory P2P State\","
            "\"ui\":\"Kanban 2-Column Board\","
            "\"sync\":\"Server-Sent Events (Central) + WebRTC DataChannel (Direct P2P)\","
            "\"online_clients\":%d,"
            "\"task_count\":%d,"
            "\"timestamp\":%ld}",
            online, count, (long)time(NULL));
        send_json_response(client_fd, 200, "OK", info_json);
        close(client_fd);
        return NULL;
    }

    /* CRUD task routes */
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
        serve_static_file(client_fd, TASKS_JSON_MIGRATION, "application/json; charset=utf-8");
    } else {
        send_error(client_fd, 404, "Not Found", "Route not found");
    }

    close(client_fd);
    return NULL;
}

/* ===================================================================
 * Main
 * =================================================================== */

int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;
    if (argc >= 2) {
        port = atoi(argv[1]);
        if (port <= 0 || port > 65535) port = DEFAULT_PORT;
    }

    signal(SIGINT,  handle_sigint);
    signal(SIGTERM, handle_sigint);
    signal(SIGPIPE, SIG_IGN);

    /* Initialize Event Broadcast system (V3.5) */
    broadcast_init();

    /* Initialize Service Layer & SQLite Repository (with migration from tasks.json) */
    if (!task_service_init(TASKS_DB, TASKS_JSON_MIGRATION)) {
        fprintf(stderr, "Failed to initialize Task Service and SQLite Repository.\n");
        return 1;
    }

    server_socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_socket_fd < 0) {
        perror("Failed to create socket");
        task_service_close();
        return 1;
    }

    int opt = 1;
    if (setsockopt(server_socket_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_REUSEADDR failed");
    }

    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family      = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port        = htons(port);

    if (bind(server_socket_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        perror("Socket bind failed");
        close(server_socket_fd);
        task_service_close();
        return 1;
    }

    if (listen(server_socket_fd, 64) < 0) {
        perror("Socket listen failed");
        close(server_socket_fd);
        task_service_close();
        return 1;
    }

    printf("===================================================\n");
    printf(" CNPM-W7 Task Manager (Version 3.5 — N-Layer + SSE)\n");
    printf(" Server listening at: http://0.0.0.0:%d\n", port);
    printf(" Architecture:        N-Layer + SSE Real-time Broadcast\n");
    printf(" Storage Engine:      SQLite3 (%s)\n", TASKS_DB);
    printf(" UI Style:            2-Column Kanban + Online Users Panel\n");
    printf(" Real-time sync:      GET /api/events  (Server-Sent Events)\n");
    printf(" Online client list:  GET /api/clients\n");
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
    broadcast_close();
    if (server_socket_fd >= 0) close(server_socket_fd);
    task_service_close();
    printf("Server stopped cleanly.\n");
    return 0;
}
