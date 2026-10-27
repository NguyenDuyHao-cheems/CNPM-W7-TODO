#ifndef EVENT_BROADCAST_H
#define EVENT_BROADCAST_H

#include <stdbool.h>
#include "cJSON.h"

/**
 * Event Broadcast System (V3.5 — Real-time Multi-User Collaboration)
 *
 * Manages Server-Sent Events (SSE) client connections and broadcasts
 * task change events to all connected clients in real-time.
 *
 * NOTE: The event format (type + JSON data) is intentionally designed
 * to be reused in V4 P2P mode via WebRTC DataChannel messages.
 */

/* Maximum number of simultaneously connected SSE clients */
#define BROADCAST_MAX_CLIENTS 32

/**
 * Event types for real-time sync.
 * This same event format will be reused in V4 for P2P DataChannel messages.
 */
typedef enum {
    EVENT_TASK_CREATED,
    EVENT_TASK_UPDATED,
    EVENT_TASK_DELETED,
    EVENT_CLIENT_JOINED,
    EVENT_CLIENT_LEFT,
    EVENT_HEARTBEAT
} event_type_t;

/**
 * Initialize the event broadcast system.
 * Must be called before any other broadcast functions.
 */
void broadcast_init(void);

/**
 * Register a new SSE client.
 * @param client_fd  The file descriptor of the SSE connection.
 * @param client_name Display name for this client (e.g. "Thiết bị A #123").
 * @return A non-negative client_id on success, -1 on failure (max clients reached).
 */
int broadcast_add_client(int client_fd, const char *client_name);

/**
 * Remove a disconnected SSE client by its registration ID.
 * Closes the underlying fd.
 */
void broadcast_remove_client(int client_id);

/**
 * Check if an SSE client (identified by client_id) is still alive.
 * Returns true if the client is still registered.
 */
bool broadcast_client_alive(int client_id);

/**
 * Broadcast a task change event to all connected SSE clients.
 * @param type      The event type.
 * @param json_data Serialized JSON payload string (task object or {"deleted_id":N}).
 */
void broadcast_event(event_type_t type, const char *json_data);

/**
 * Get count of currently connected SSE clients.
 */
int broadcast_get_client_count(void);

/**
 * Get a cJSON array of connected client names.
 * Caller must free the returned pointer with cJSON_Delete().
 */
cJSON *broadcast_get_client_list(void);

/**
 * Cleanup all client connections and free resources.
 */
void broadcast_close(void);

#endif /* EVENT_BROADCAST_H */
