package com.jnf.dbservice;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** 写闸门（allow-write=false）与可选 X-API-Key 鉴权。 */
@SpringBootTest
@AutoConfigureMockMvc
class WriteGateAndApiKeyTest {

    static final Path DATA_DIR;
    static final String API_KEY = "test-secret-key";

    static {
        try {
            DATA_DIR = Files.createTempDirectory("db-service-gate-");
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("db-service.data-dir", DATA_DIR::toString);
        registry.add("db-service.allow-write", () -> "false");
        registry.add("DB_SERVICE_API_KEY", () -> API_KEY);
    }

    @Autowired
    MockMvc mockMvc;

    @Autowired
    ObjectMapper objectMapper;

    private JsonNode execute(MockMvcRequestBuildersBuilder builder) throws Exception {
        MvcResult result = mockMvc.perform(builder.build().accept(MediaType.APPLICATION_JSON)).andReturn();
        assertEquals(200, result.getResponse().getStatus());
        return objectMapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    /** 简单包装，便于带/不带 X-API-Key。 */
    static final class MockMvcRequestBuildersBuilder {
        private final org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder delegate;
        private String apiKey;

        MockMvcRequestBuildersBuilder(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder delegate) {
            this.delegate = delegate.contentType(MediaType.APPLICATION_JSON);
        }

        MockMvcRequestBuildersBuilder apiKey(String key) {
            this.apiKey = key;
            return this;
        }

        org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder build() {
            if (apiKey != null) {
                delegate.header("X-API-Key", apiKey);
            }
            return delegate;
        }
    }

    @Test
    @DisplayName("API Key：未带 Key 返回 40100；带正确 Key 正常；/api/health 豁免")
    void api_key_is_optional_but_enforced_when_configured() throws Exception {
        JsonNode denied = execute(new MockMvcRequestBuildersBuilder(get("/api/datasources")));
        assertEquals("40100", denied.path("code").asText(), denied.toString());

        JsonNode allowed = execute(new MockMvcRequestBuildersBuilder(get("/api/datasources")).apiKey(API_KEY));
        assertEquals("00000", allowed.path("code").asText(), allowed.toString());

        JsonNode health = execute(new MockMvcRequestBuildersBuilder(get("/api/health")));
        assertEquals("00000", health.path("code").asText(), health.toString());
    }

    @Test
    @DisplayName("API Key 模式下 CORS 预检 OPTIONS 不被 40100 拦截，并返回 CORS 头")
    void cors_preflight_is_not_blocked_by_api_key() throws Exception {
        org.springframework.test.web.servlet.MvcResult preflight = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options("/api/datasources")
                                .header("Origin", "http://localhost:5173")
                                .header("Access-Control-Request-Method", "GET")
                                .header("Access-Control-Request-Headers", "content-type"))
                .andReturn();
        assertEquals(200, preflight.getResponse().getStatus());
        String body = preflight.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertTrue(body == null || body.isEmpty() || !body.contains("40100"), body);
        assertEquals("http://localhost:5173", preflight.getResponse().getHeader("Access-Control-Allow-Origin"));

        // 未带 Key 的失败响应也要带 CORS 头，前端才能读到 40100
        org.springframework.test.web.servlet.MvcResult denied = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/datasources")
                                .header("Origin", "http://localhost:5173"))
                .andReturn();
        JsonNode deniedBody = objectMapper.readTree(denied.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertEquals("40100", deniedBody.path("code").asText(), deniedBody.toString());
        assertEquals("http://localhost:5173", denied.getResponse().getHeader("Access-Control-Allow-Origin"));
    }

    @Test
    @DisplayName("写闸门：allow-write=false 时 execute/rows 一律 40000（即使 confirmed=true）")
    void write_endpoints_are_disabled_by_configuration() throws Exception {
        String registerBody = "{\"type\":\"custom\",\"name\":\"gate-db\","
                + "\"jdbcUrl\":\"jdbc:h2:mem:svc_gate;DB_CLOSE_DELAY=-1\",\"user\":\"sa\"}";
        JsonNode registered = execute(new MockMvcRequestBuildersBuilder(
                post("/api/datasources").content(registerBody)).apiKey(API_KEY));
        assertEquals("00000", registered.path("code").asText(), registered.toString());
        String id = registered.path("data").path("id").asText();

        JsonNode exec = execute(new MockMvcRequestBuildersBuilder(
                post("/api/datasources/" + id + "/execute")
                        .content("{\"sql\":\"CREATE TABLE g (id INT)\",\"confirmed\":true}")).apiKey(API_KEY));
        assertEquals("40000", exec.path("code").asText(), exec.toString());
        assertTrue(exec.path("info").asText().contains("写操作被禁用"));

        JsonNode rows = execute(new MockMvcRequestBuildersBuilder(
                post("/api/datasources/" + id + "/rows/insert")
                        .content("{\"table\":\"g\",\"values\":{\"id\":1},\"confirmed\":true}")).apiKey(API_KEY));
        assertEquals("40000", rows.path("code").asText(), rows.toString());
        assertTrue(rows.path("info").asText().contains("写操作被禁用"));
    }
}



