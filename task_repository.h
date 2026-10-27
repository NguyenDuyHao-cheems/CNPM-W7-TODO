#ifndef TASK_REPOSITORY_H
#define TASK_REPOSITORY_H

#include <stdbool.h>
#include <time.h>
#include "cJSON.h"

/**
 * Task Entity
 */
typedef struct {
    int id;
    char title[512];
    bool completed;
    time_t created_at;
} task_entity_t;

/**
 * Initialize repository with SQLite database.
 * If database is fresh and migration_json_path exists, migrates data from JSON to SQLite.
 */
bool repo_init(const char *db_path, const char *migration_json_path);

/**
 * Retrieve all tasks as a cJSON array. Caller must free returned cJSON with cJSON_Delete().
 */
cJSON *repo_get_all_tasks(void);

/**
 * Create a new task in SQLite.
 * Returns true on success and populates out_task.
 */
bool repo_create_task(const char *title, task_entity_t *out_task);

/**
 * Update an existing task in SQLite.
 * If completed != NULL, updates status.
 * If title != NULL, updates title.
 * Returns true on success and populates out_task.
 */
bool repo_update_task(int id, const bool *completed, const char *title, task_entity_t *out_task);

/**
 * Delete a task from SQLite by ID.
 * Returns true if deleted, false if not found or error.
 */
bool repo_delete_task(int id);

/**
 * Get total task count in database.
 */
int repo_get_task_count(void);

/**
 * Close database connection and clean up resources.
 */
void repo_close(void);

#endif /* TASK_REPOSITORY_H */
