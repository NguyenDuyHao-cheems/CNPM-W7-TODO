#ifndef TASK_SERVICE_H
#define TASK_SERVICE_H

#include <stdbool.h>
#include <stddef.h>
#include "cJSON.h"

/**
 * Business Logic Layer (Task Service)
 * Encapsulates task validation and business rules.
 * Independent of HTTP/Presentation and Database/Persistence implementations.
 */

bool task_service_init(const char *db_path, const char *migration_json_path);
cJSON *task_service_get_all(void);
cJSON *task_service_create(const char *title, char *err_buf, size_t err_size);
cJSON *task_service_update(int id, const bool *completed, const char *title, char *err_buf, size_t err_size);
bool task_service_delete(int id, char *err_buf, size_t err_size);
int task_service_count(void);
void task_service_close(void);

#endif /* TASK_SERVICE_H */
