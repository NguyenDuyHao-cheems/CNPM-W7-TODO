#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <pthread.h>
#include <sqlite3.h>
#include "task_repository.h"
#include "cJSON.h"

static sqlite3 *db = NULL;
static pthread_mutex_t db_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Read entire file into heap buffer */
static char *read_file_to_string(const char *path) {
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
    return buffer;
}

/* Migrate data from tasks.json to SQLite if tasks table is empty */
static void migrate_from_json_if_needed(const char *json_path) {
    if (!json_path || !db) return;

    sqlite3_stmt *stmt = NULL;
    int count = 0;
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM tasks;", -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }

    if (count > 0) {
        return; // Already has data, skip migration
    }

    char *json_content = read_file_to_string(json_path);
    if (!json_content) return;

    cJSON *root = cJSON_Parse(json_content);
    free(json_content);

    if (!root || !cJSON_IsArray(root)) {
        if (root) cJSON_Delete(root);
        return;
    }

    int migrated = 0;
    sqlite3_exec(db, "BEGIN TRANSACTION;", NULL, NULL, NULL);

    const char *insert_sql = "INSERT INTO tasks (id, title, completed, created_at) VALUES (?, ?, ?, ?);";
    if (sqlite3_prepare_v2(db, insert_sql, -1, &stmt, NULL) == SQLITE_OK) {
        cJSON *item = NULL;
        cJSON_ArrayForEach(item, root) {
            cJSON *id_obj = cJSON_GetObjectItemCaseSensitive(item, "id");
            cJSON *title_obj = cJSON_GetObjectItemCaseSensitive(item, "title");
            cJSON *completed_obj = cJSON_GetObjectItemCaseSensitive(item, "completed");
            cJSON *created_obj = cJSON_GetObjectItemCaseSensitive(item, "created_at");

            if (title_obj && cJSON_IsString(title_obj)) {
                int id = id_obj ? id_obj->valueint : 0;
                const char *title = title_obj->valuestring;
                int completed = (completed_obj && cJSON_IsTrue(completed_obj)) ? 1 : 0;
                time_t created_at = created_obj ? (time_t)created_obj->valuedouble : time(NULL);

                sqlite3_reset(stmt);
                if (id > 0) {
                    sqlite3_bind_int(stmt, 1, id);
                } else {
                    sqlite3_bind_null(stmt, 1);
                }
                sqlite3_bind_text(stmt, 2, title, -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(stmt, 3, completed);
                sqlite3_bind_int64(stmt, 4, (sqlite3_int64)created_at);

                if (sqlite3_step(stmt) == SQLITE_DONE) {
                    migrated++;
                }
            }
        }
        sqlite3_finalize(stmt);
    }

    sqlite3_exec(db, "COMMIT;", NULL, NULL, NULL);
    cJSON_Delete(root);

    printf("[Migration] Thành công chuyển đổi %d công việc từ '%s' sang SQLite database!\n", migrated, json_path);
    fflush(stdout);
}

bool repo_init(const char *db_path, const char *migration_json_path) {
    pthread_mutex_lock(&db_mutex);

    int rc = sqlite3_open_v2(db_path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, NULL);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Cannot open SQLite database %s: %s\n", db_path, sqlite3_errmsg(db));
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    // Enable WAL mode for high concurrency
    sqlite3_exec(db, "PRAGMA journal_mode = WAL;", NULL, NULL, NULL);

    const char *schema_sql =
        "CREATE TABLE IF NOT EXISTS tasks ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  title TEXT NOT NULL,"
        "  completed INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL"
        ");";

    char *err_msg = NULL;
    rc = sqlite3_exec(db, schema_sql, NULL, NULL, &err_msg);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Failed to create tasks schema: %s\n", err_msg);
        sqlite3_free(err_msg);
        sqlite3_close(db);
        db = NULL;
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    migrate_from_json_if_needed(migration_json_path);

    pthread_mutex_unlock(&db_mutex);
    return true;
}

cJSON *repo_get_all_tasks(void) {
    pthread_mutex_lock(&db_mutex);
    if (!db) {
        pthread_mutex_unlock(&db_mutex);
        return NULL;
    }

    cJSON *arr = cJSON_CreateArray();
    const char *sql = "SELECT id, title, completed, created_at FROM tasks ORDER BY id DESC;";
    sqlite3_stmt *stmt = NULL;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
            cJSON_AddStringToObject(item, "title", (const char *)sqlite3_column_text(stmt, 1));
            cJSON_AddBoolToObject(item, "completed", sqlite3_column_int(stmt, 2) != 0);
            cJSON_AddNumberToObject(item, "created_at", (double)sqlite3_column_int64(stmt, 3));
            cJSON_AddItemToArray(arr, item);
        }
        sqlite3_finalize(stmt);
    }

    pthread_mutex_unlock(&db_mutex);
    return arr;
}

bool repo_create_task(const char *title, task_entity_t *out_task) {
    if (!title || strlen(title) == 0) return false;

    pthread_mutex_lock(&db_mutex);
    if (!db) {
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    time_t now = time(NULL);
    const char *sql = "INSERT INTO tasks (title, completed, created_at) VALUES (?, 0, ?);";
    sqlite3_stmt *stmt = NULL;
    bool success = false;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, title, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 2, (sqlite3_int64)now);

        if (sqlite3_step(stmt) == SQLITE_DONE) {
            if (out_task) {
                out_task->id = (int)sqlite3_last_insert_rowid(db);
                strncpy(out_task->title, title, sizeof(out_task->title) - 1);
                out_task->title[sizeof(out_task->title) - 1] = '\0';
                out_task->completed = false;
                out_task->created_at = now;
            }
            success = true;
        }
        sqlite3_finalize(stmt);
    }

    pthread_mutex_unlock(&db_mutex);
    return success;
}

bool repo_update_task(int id, const bool *completed, const char *title, task_entity_t *out_task) {
    if (id <= 0) return false;

    pthread_mutex_lock(&db_mutex);
    if (!db) {
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    // Dynamic SQL update based on provided fields
    char sql[512];
    if (completed != NULL && title != NULL) {
        snprintf(sql, sizeof(sql), "UPDATE tasks SET completed = %d, title = ? WHERE id = %d;", *completed ? 1 : 0, id);
    } else if (completed != NULL) {
        snprintf(sql, sizeof(sql), "UPDATE tasks SET completed = %d WHERE id = %d;", *completed ? 1 : 0, id);
    } else if (title != NULL) {
        snprintf(sql, sizeof(sql), "UPDATE tasks SET title = ? WHERE id = %d;", id);
    } else {
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    sqlite3_stmt *stmt = NULL;
    bool success = false;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        if (title != NULL) {
            sqlite3_bind_text(stmt, 1, title, -1, SQLITE_TRANSIENT);
        }

        if (sqlite3_step(stmt) == SQLITE_DONE && sqlite3_changes(db) > 0) {
            success = true;
        }
        sqlite3_finalize(stmt);
    }

    // Retrieve updated record if required
    if (success && out_task) {
        const char *select_sql = "SELECT id, title, completed, created_at FROM tasks WHERE id = ?;";
        if (sqlite3_prepare_v2(db, select_sql, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_int(stmt, 1, id);
            if (sqlite3_step(stmt) == SQLITE_ROW) {
                out_task->id = sqlite3_column_int(stmt, 0);
                strncpy(out_task->title, (const char *)sqlite3_column_text(stmt, 1), sizeof(out_task->title) - 1);
                out_task->title[sizeof(out_task->title) - 1] = '\0';
                out_task->completed = sqlite3_column_int(stmt, 2) != 0;
                out_task->created_at = (time_t)sqlite3_column_int64(stmt, 3);
            }
            sqlite3_finalize(stmt);
        }
    }

    pthread_mutex_unlock(&db_mutex);
    return success;
}

bool repo_delete_task(int id) {
    if (id <= 0) return false;

    pthread_mutex_lock(&db_mutex);
    if (!db) {
        pthread_mutex_unlock(&db_mutex);
        return false;
    }

    const char *sql = "DELETE FROM tasks WHERE id = ?;";
    sqlite3_stmt *stmt = NULL;
    bool success = false;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, id);
        if (sqlite3_step(stmt) == SQLITE_DONE && sqlite3_changes(db) > 0) {
            success = true;
        }
        sqlite3_finalize(stmt);
    }

    pthread_mutex_unlock(&db_mutex);
    return success;
}

int repo_get_task_count(void) {
    pthread_mutex_lock(&db_mutex);
    if (!db) {
        pthread_mutex_unlock(&db_mutex);
        return 0;
    }

    int count = 0;
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM tasks;", -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }

    pthread_mutex_unlock(&db_mutex);
    return count;
}

void repo_close(void) {
    pthread_mutex_lock(&db_mutex);
    if (db) {
        sqlite3_close_v2(db);
        db = NULL;
    }
    pthread_mutex_unlock(&db_mutex);
}
