package com.example.taskmanager.controller;

import com.example.taskmanager.dto.CreateTaskRequest;
import com.example.taskmanager.dto.TaskResponse;
import com.example.taskmanager.model.Task;
import com.example.taskmanager.model.TaskStatus;
import com.example.taskmanager.service.TaskService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/tasks")
public class TaskController {

    private final TaskService service;

    public TaskController(TaskService service) {
        this.service = service;
    }

    @GetMapping
    public List<TaskResponse> list() {
        return service.listTasks().stream().map(TaskResponse::from).toList();
    }

    @GetMapping("/{id}")
    public TaskResponse get(@PathVariable String id) {
        return TaskResponse.from(service.getTask(id));
    }

    @PostMapping
    public TaskResponse create(@Valid @RequestBody CreateTaskRequest request) {
        return TaskResponse.from(service.createTask(request));
    }

    @PutMapping("/{id}")
    public TaskResponse update(@PathVariable String id, @Valid @RequestBody CreateTaskRequest request) {
        return TaskResponse.from(service.updateTask(id, request));
    }

    @PatchMapping("/{id}/status")
    public TaskResponse updateStatus(@PathVariable String id, @RequestBody TaskStatus status) {
        return TaskResponse.from(service.updateTaskStatus(id, status));
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) {
        service.deleteTask(id);
    }

    @GetMapping("/search")
    public List<TaskResponse> search(@RequestParam("q") String query) {
        return service.searchTasks(query).stream().map(TaskResponse::from).toList();
    }
}
