package com.example.taskmanager.service;

import com.example.taskmanager.dto.CreateTaskRequest;
import com.example.taskmanager.exception.TaskNotFoundException;
import com.example.taskmanager.model.Task;
import com.example.taskmanager.model.TaskStatus;
import com.example.taskmanager.repository.TaskRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class TaskService {

    private final TaskRepository repository;

    public TaskService(TaskRepository repository) {
        this.repository = repository;
    }

    public List<Task> listTasks() {
        return repository.findAll();
    }

    public Task getTask(String id) {
        Task task = repository.findById(id);
        if (task == null) {
            throw new TaskNotFoundException(id);
        }
        return task;
    }

    public Task createTask(CreateTaskRequest request) {
        Task task = new Task(
            UUID.randomUUID().toString(),
            request.getTitle(),
            request.getDescription(),
            request.getPriority()
        );
        repository.save(task);
        return task;
    }

    public Task updateTask(String id, CreateTaskRequest request) {
        Task existing = repository.findById(id);
        existing.setTitle(request.getTitle());
        existing.setDescription(request.getDescription());
        existing.setPriority(request.getPriority());
        existing.setUpdatedAt(Instant.now());
        repository.save(existing);
        return existing;
    }

    public Task updateTaskStatus(String id, TaskStatus status) {
        Task task = getTask(id);
        task.setStatus(status);
        task.setUpdatedAt(Instant.now());
        repository.save(task);
        return task;
    }

    public void deleteTask(String id) {
        boolean deleted = repository.delete(id);
        if (!deleted) {
            throw new TaskNotFoundException(id);
        }
    }

    public List<Task> searchTasks(String query) {
        String lower = query.toLowerCase();
        return repository.findAll().stream()
            .filter(t ->
                t.getTitle().toLowerCase().contains(lower) ||
                (t.getDescription() != null && t.getDescription().toLowerCase().contains(lower)))
            .toList();
    }
}
