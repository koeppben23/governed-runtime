package com.example.taskmanager.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.taskmanager.dto.CreateTaskRequest;
import com.example.taskmanager.exception.TaskNotFoundException;
import com.example.taskmanager.model.Priority;
import com.example.taskmanager.model.Task;
import com.example.taskmanager.model.TaskStatus;
import com.example.taskmanager.repository.TaskRepository;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TaskServiceTest {

    private TaskRepository repository;
    private TaskService service;

    @BeforeEach
    void setUp() {
        repository = new TaskRepository();
        service = new TaskService(repository);
    }

    @Test
    void create_and_retrieve_task() {
        var req = new CreateTaskRequest();
        req.setTitle("Fix login bug");
        req.setDescription("Users cannot log in");
        req.setPriority(Priority.HIGH);

        Task created = service.createTask(req);

        assertThat(created.getTitle()).isEqualTo("Fix login bug");
        assertThat(created.getPriority()).isEqualTo(Priority.HIGH);
        assertThat(created.getStatus()).isEqualTo(TaskStatus.TODO);

        Task retrieved = service.getTask(created.getId());
        assertThat(retrieved).isEqualTo(created);
    }

    @Test
    void list_tasks_returns_all() {
        var req = new CreateTaskRequest();
        req.setTitle("Task A");
        req.setPriority(Priority.MEDIUM);
        service.createTask(req);

        req.setTitle("Task B");
        service.createTask(req);

        List<Task> tasks = service.listTasks();
        assertThat(tasks).hasSize(2);
    }

    @Test
    void update_existing_task() {
        var req = new CreateTaskRequest();
        req.setTitle("Original");
        req.setPriority(Priority.LOW);
        Task created = service.createTask(req);

        var update = new CreateTaskRequest();
        update.setTitle("Updated");
        update.setDescription("New description");
        update.setPriority(Priority.HIGH);
        Task updated = service.updateTask(created.getId(), update);

        assertThat(updated.getTitle()).isEqualTo("Updated");
        assertThat(updated.getDescription()).isEqualTo("New description");
        assertThat(updated.getPriority()).isEqualTo(Priority.HIGH);
    }

    @Test
    void update_task_status() {
        var req = new CreateTaskRequest();
        req.setTitle("Task");
        req.setPriority(Priority.MEDIUM);
        Task created = service.createTask(req);

        Task updated = service.updateTaskStatus(created.getId(), TaskStatus.DONE);

        assertThat(updated.getStatus()).isEqualTo(TaskStatus.DONE);
    }

    @Test
    void delete_existing_task() {
        var req = new CreateTaskRequest();
        req.setTitle("To delete");
        req.setPriority(Priority.LOW);
        Task created = service.createTask(req);

        service.deleteTask(created.getId());

        assertThatThrownBy(() -> service.getTask(created.getId()))
            .isInstanceOf(TaskNotFoundException.class);
    }

    @Test
    void get_non_existent_task_throws() {
        assertThatThrownBy(() -> service.getTask("non-existent"))
            .isInstanceOf(TaskNotFoundException.class);
    }

    @Test
    void search_finds_by_title() {
        var req = new CreateTaskRequest();
        req.setTitle("Authentication module");
        req.setPriority(Priority.HIGH);
        service.createTask(req);

        req.setTitle("Database migration");
        service.createTask(req);

        List<Task> results = service.searchTasks("auth");
        assertThat(results).hasSize(1);
        assertThat(results.get(0).getTitle()).isEqualTo("Authentication module");
    }
}
