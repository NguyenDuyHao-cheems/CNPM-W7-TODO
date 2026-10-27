CC = gcc
CFLAGS = -Wall -Wextra -O2 -pthread
LDFLAGS = -pthread

TARGET = server
SRCS = server.c cJSON.c
OBJS = $(SRCS:.c=.o)

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) -o $(TARGET) $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(OBJS) $(TARGET) tasks.json.tmp

.PHONY: all run clean
