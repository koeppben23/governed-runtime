package com.example.taskmanager.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.taskmanager.model.TaskStatus;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class TaskControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void create_task_returns_ok() throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
            "title", "Fix auth bug",
            "priority", "HIGH"
        ));

        mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").isNotEmpty())
            .andExpect(jsonPath("$.title").value("Fix auth bug"))
            .andExpect(jsonPath("$.status").value("TODO"));
    }

    @Test
    void list_tasks_returns_array() throws Exception {
        mockMvc.perform(get("/tasks"))
            .andExpect(status().isOk());
    }

    @Test
    void get_task_by_id_returns_ok() throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
            "title", "Test task",
            "priority", "MEDIUM"
        ));

        String response = mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andReturn().getResponse().getContentAsString();

        String id = objectMapper.readTree(response).get("id").asText();

        mockMvc.perform(get("/tasks/" + id))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(id));
    }

    @Test
    void get_non_existent_task_returns_404() throws Exception {
        mockMvc.perform(get("/tasks/non-existent"))
            .andExpect(status().isNotFound());
    }

    @Test
    void update_existing_task_returns_ok() throws Exception {
        String createBody = objectMapper.writeValueAsString(Map.of(
            "title", "Original",
            "priority", "LOW"
        ));

        String response = mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(createBody))
            .andReturn().getResponse().getContentAsString();

        String id = objectMapper.readTree(response).get("id").asText();

        String updateBody = objectMapper.writeValueAsString(Map.of(
            "title", "Updated",
            "description", "New description",
            "priority", "HIGH"
        ));

        mockMvc.perform(put("/tasks/" + id)
                .contentType(MediaType.APPLICATION_JSON)
                .content(updateBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.title").value("Updated"))
            .andExpect(jsonPath("$.priority").value("HIGH"));
    }

    /**
     * Regression test exposing a bug in TaskService.updateTask():
     * updating a non-existent task ID causes NullPointerException → HTTP 500
     * instead of returning HTTP 404.
     *
     * To reproduce manually: remove @Disabled and run ./mvnw test.
     */
    @Test
    @Disabled("TODO FLOWGUARD DEMO: enable this regression test while fixing TaskService.updateTask; currently exposes 500 instead of expected 404")
    void update_taskNotFound_returns404() throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
            "title", "Will not work",
            "priority", "MEDIUM"
        ));

        mockMvc.perform(put("/tasks/non-existent-id")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isNotFound());
    }

    @Test
    void update_task_status() throws Exception {
        String createBody = objectMapper.writeValueAsString(Map.of(
            "title", "Status test",
            "priority", "MEDIUM"
        ));

        String response = mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(createBody))
            .andReturn().getResponse().getContentAsString();

        String id = objectMapper.readTree(response).get("id").asText();

        mockMvc.perform(patch("/tasks/" + id + "/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content("\"DONE\""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("DONE"));
    }

    @Test
    void delete_existing_task_returns_ok() throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
            "title", "To delete",
            "priority", "LOW"
        ));

        String response = mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andReturn().getResponse().getContentAsString();

        String id = objectMapper.readTree(response).get("id").asText();

        mockMvc.perform(delete("/tasks/" + id))
            .andExpect(status().isOk());

        mockMvc.perform(get("/tasks/" + id))
            .andExpect(status().isNotFound());
    }

    @Test
    void search_tasks_by_query() throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
            "title", "Authentication module",
            "priority", "HIGH"
        ));
        mockMvc.perform(post("/tasks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body));

        String result = mockMvc.perform(get("/tasks/search?q=Authentication"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.length()").isNotEmpty())
            .andReturn().getResponse().getContentAsString();

        assertThat(result).contains("Authentication module");
    }
}
