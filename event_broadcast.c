#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <errno.h>
#include "event_broadcast.h"
#include "cJSON.h"

/* SSE event type name strings — reused as V4 P2P DataChannel message type field */
static const char *event_type_name(event_type_t type) {
    switch (type) {
        case EVENT_TASK_CREATED:  return "task_created";
        case EVENT_TASK_UPDATED:  return "task_updated";
        case EVENT_TASK_DELETED:  return "task_deleted";
        case EVENT_CLIENT_JOINED: return "client_joined";
        case EVENT_CLIENT_LEFT:   return "client_left";
        case EVENT_HEARTBEAT:     return "heartbeat";
        default:                  return "unknown";
    }
}

/* -------------------------------------------------------------------
 * Client registry
 * ------------------------------------------------------------------- */

typedef struct {
    int  fd;                          /* SSE client socket fd; -1 = free slot */
    int  id;                          /* Unique registration id                */
    char name[256];                   /* Display name for this client           */
    bool alive;                       /* Still connected?                       */
} sse_client_t;

static sse_client_t  clients[BROADCAST_MAX_CLIENTS];
static int           next_id = 1;
static pthread_mutex_t bc_mutex = PTHREAD_MUTEX_INITIALIZER;

void broadcast_init(void) {
    pthread_mutex_lock(&bc_mutex);
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        clients[i].fd    = -1;
        clients[i].id    = -1;
        clients[i].alive = false;
        clients[i].name[0] = '\0';
    }
    pthread_mutex_unlock(&bc_mutex);
}

int broadcast_add_client(int client_fd, const char *client_name) {
    pthread_mutex_lock(&bc_mutex);

    int slot = -1;
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].fd < 0) {
            slot = i;
            break;
        }
    }

    if (slot < 0) {
        pthread_mutex_unlock(&bc_mutex);
        return -1; /* No free slots */
    }

    int assigned_id = next_id++;
    clients[slot].fd    = client_fd;
    clients[slot].id    = assigned_id;
    clients[slot].alive = true;

    if (client_name && client_name[0]) {
        strncpy(clients[slot].name, client_name, sizeof(clients[slot].name) - 1);
        clients[slot].name[sizeof(clients[slot].name) - 1] = '\0';
    } else {
        snprintf(clients[slot].name, sizeof(clients[slot].name),
                 "Client #%d", assigned_id);
    }

    pthread_mutex_unlock(&bc_mutex);
    return assigned_id;
}

void broadcast_remove_client(int client_id) {
    pthread_mutex_lock(&bc_mutex);
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].id == client_id) {
            if (clients[i].fd >= 0) {
                close(clients[i].fd);
            }
            clients[i].fd    = -1;
            clients[i].id    = -1;
            clients[i].alive = false;
            clients[i].name[0] = '\0';
            break;
        }
    }
    pthread_mutex_unlock(&bc_mutex);
}

bool broadcast_client_alive(int client_id) {
    pthread_mutex_lock(&bc_mutex);
    bool alive = false;
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].id == client_id) {
            alive = clients[i].alive;
            break;
        }
    }
    pthread_mutex_unlock(&bc_mutex);
    return alive;
}

/* -------------------------------------------------------------------
 * Broadcast
 * ------------------------------------------------------------------- */

/**
 * Format and send a single SSE message to one client fd.
 * SSE wire format:
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 * Returns false if the send failed (client disconnected).
 */
static bool send_sse_message(int fd, const char *event_name, const char *json_data) {
    char buf[65536];
    int len = snprintf(buf, sizeof(buf),
                       "event: %s\ndata: %s\n\n",
                       event_name,
                       json_data ? json_data : "{}");
    if (len <= 0 || len >= (int)sizeof(buf)) return false;

    ssize_t sent = send(fd, buf, (size_t)len, MSG_NOSIGNAL);
    return sent == (ssize_t)len;
}

void broadcast_event(event_type_t type, const char *json_data) {
    const char *ename = event_type_name(type);

    pthread_mutex_lock(&bc_mutex);
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].fd < 0 || !clients[i].alive) continue;

        bool ok = send_sse_message(clients[i].fd, ename, json_data);
        if (!ok) {
            /* Mark dead — will be cleaned up by the SSE thread */
            clients[i].alive = false;
            fprintf(stderr, "[SSE] Client '%s' (id=%d) disconnected\n",
                    clients[i].name, clients[i].id);
            fflush(stderr);
        }
    }
    pthread_mutex_unlock(&bc_mutex);
}

/* -------------------------------------------------------------------
 * Queries
 * ------------------------------------------------------------------- */

int broadcast_get_client_count(void) {
    pthread_mutex_lock(&bc_mutex);
    int count = 0;
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].fd >= 0 && clients[i].alive) count++;
    }
    pthread_mutex_unlock(&bc_mutex);
    return count;
}

cJSON *broadcast_get_client_list(void) {
    pthread_mutex_lock(&bc_mutex);
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].fd >= 0 && clients[i].alive) {
            cJSON *obj = cJSON_CreateObject();
            cJSON_AddNumberToObject(obj, "id",   clients[i].id);
            cJSON_AddStringToObject(obj, "name", clients[i].name);
            cJSON_AddItemToArray(arr, obj);
        }
    }
    pthread_mutex_unlock(&bc_mutex);
    return arr;
}

/* -------------------------------------------------------------------
 * Shutdown
 * ------------------------------------------------------------------- */

void broadcast_close(void) {
    pthread_mutex_lock(&bc_mutex);
    for (int i = 0; i < BROADCAST_MAX_CLIENTS; i++) {
        if (clients[i].fd >= 0) {
            close(clients[i].fd);
            clients[i].fd    = -1;
            clients[i].id    = -1;
            clients[i].alive = false;
        }
    }
    pthread_mutex_unlock(&bc_mutex);
}
