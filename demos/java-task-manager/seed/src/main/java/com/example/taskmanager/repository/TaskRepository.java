package com.example.taskmanager.repository;

import com.example.taskmanager.model.Task;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class TaskRepository {

    private final Map<String, Task> storage = new ConcurrentHashMap<>();

    public List<Task> findAll() {
        return new ArrayList<>(storage.values());
    }

    public Task findById(String id) {
        return storage.get(id);
    }

    public void save(Task task) {
        storage.put(task.getId(), task);
    }

    public boolean delete(String id) {
        return storage.remove(id) != null;
    }
}
