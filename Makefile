CC = gcc
CFLAGS = -Wall -Wextra -O2 -pthread
LDFLAGS = -pthread -lsqlite3

TARGET = server
SRCS = server.c task_service.c sqlite_repository.c cJSON.c
OBJS = $(SRCS:.c=.o)
HEADERS = task_service.h task_repository.h cJSON.h

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) -o $(TARGET) $(LDFLAGS)

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c $< -o $@

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(OBJS) $(TARGET) tasks.json.tmp tasks.db-wal tasks.db-shm

.PHONY: all run clean
