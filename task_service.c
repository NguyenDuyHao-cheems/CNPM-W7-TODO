#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "task_service.h"
#include "task_repository.h"

/* Helper: check if string is null or whitespace only */
static bool is_blank(const char *str) {
    if (!str) return true;
    while (*str) {
        if (!isspace((unsigned char)*str)) return false;
        str++;
    }
    return true;
}

bool task_service_init(const char *db_path, const char *migration_json_path) {
    return repo_init(db_path, migration_json_path);
}

cJSON *task_service_get_all(void) {
    return repo_get_all_tasks();
}

cJSON *task_service_create(const char *title, char *err_buf, size_t err_size) {
    if (is_blank(title)) {
        if (err_buf) snprintf(err_buf, err_size, "Tiêu đề công việc không được để trống");
        return NULL;
    }

    if (strlen(title) > 500) {
        if (err_buf) snprintf(err_buf, err_size, "Tiêu đề công việc quá dài (tối đa 500 ký tự)");
        return NULL;
    }

    task_entity_t task;
    if (!repo_create_task(title, &task)) {
        if (err_buf) snprintf(err_buf, err_size, "Lỗi khi lưu công việc vào cơ sở dữ liệu");
        return NULL;
    }

    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "id", task.id);
    cJSON_AddStringToObject(item, "title", task.title);
    cJSON_AddBoolToObject(item, "completed", task.completed);
    cJSON_AddNumberToObject(item, "created_at", (double)task.created_at);
    return item;
}

cJSON *task_service_update(int id, const bool *completed, const char *title, char *err_buf, size_t err_size) {
    if (id <= 0) {
        if (err_buf) snprintf(err_buf, err_size, "Mã công việc không hợp lệ (ID <= 0)");
        return NULL;
    }

    if (title != NULL && is_blank(title)) {
        if (err_buf) snprintf(err_buf, err_size, "Tiêu đề mới không được để trống");
        return NULL;
    }

    task_entity_t task;
    if (!repo_update_task(id, completed, title, &task)) {
        if (err_buf) snprintf(err_buf, err_size, "Không tìm thấy công việc với ID #%d để cập nhật", id);
        return NULL;
    }

    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "id", task.id);
    cJSON_AddStringToObject(item, "title", task.title);
    cJSON_AddBoolToObject(item, "completed", task.completed);
    cJSON_AddNumberToObject(item, "created_at", (double)task.created_at);
    return item;
}

bool task_service_delete(int id, char *err_buf, size_t err_size) {
    if (id <= 0) {
        if (err_buf) snprintf(err_buf, err_size, "Mã công việc không hợp lệ");
        return false;
    }

    if (!repo_delete_task(id)) {
        if (err_buf) snprintf(err_buf, err_size, "Không tìm thấy công việc với ID #%d để xóa", id);
        return false;
    }

    return true;
}

int task_service_count(void) {
    return repo_get_task_count();
}

void task_service_close(void) {
    repo_close();
}
