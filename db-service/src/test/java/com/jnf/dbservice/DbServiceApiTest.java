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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * 数据源服务主链路单测（H2 内存库 + 临时数据目录，allow-write=true）：
 * 数据源 CRUD、元数据、数据浏览、查询/写入、行 CRUD、Agent 紧凑查询与增量读取。
 */
@SpringBootTest
@AutoConfigureMockMvc
class DbServiceApiTest {

    static final Path DATA_DIR;

    static {
        try {
            DATA_DIR = Files.createTempDirectory("db-service-api-");
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("db-service.data-dir", DATA_DIR::toString);
        registry.add("db-service.allow-write", () -> "true");
        registry.add("DB_SERVICE_API_KEY", () -> "");
    }

    @Autowired
    MockMvc mockMvc;

    @Autowired
    ObjectMapper objectMapper;

    /* ------------------------------ 基础工具 ------------------------------ */

    private JsonNode call(MockHttpServletRequestBuilder builder) throws Exception {
        MvcResult result = mockMvc.perform(builder.accept(MediaType.APPLICATION_JSON)).andReturn();
        assertEquals(200, result.getResponse().getStatus(), result.getResponse().getContentAsString());
        String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return objectMapper.readTree(body);
    }

    private JsonNode getJson(String path) throws Exception {
        return call(get(path));
    }

    private JsonNode postJson(String path, String body) throws Exception {
        return call(post(path).contentType(MediaType.APPLICATION_JSON).content(body));
    }

    private JsonNode putJson(String path, String body) throws Exception {
        return call(put(path).contentType(MediaType.APPLICATION_JSON).content(body));
    }

    private JsonNode deleteJson(String path) throws Exception {
        return call(delete(path));
    }

    private static String json(String body) {
        return body;
    }

    /** 注册一个自定义 H2 内存数据源，返回 id。 */
    private String registerMemDatasource(String name, String dbName) throws Exception {
        String body = "{\"type\":\"custom\",\"name\":\"" + name + "\",\"jdbcUrl\":\"jdbc:h2:mem:" + dbName
                + ";DB_CLOSE_DELAY=-1\",\"user\":\"sa\"}";
        JsonNode response = postJson("/api/datasources", body);
        assertEquals("00000", response.path("code").asText(), response.toString());
        return response.path("data").path("id").asText();
    }

    private void execute(String id, String sql) throws Exception {
        JsonNode response = postJson("/api/datasources/" + id + "/execute",
                "{\"sql\":" + objectMapper.writeValueAsString(sql) + ",\"confirmed\":true}");
        assertEquals("00000", response.path("code").asText(), response.toString());
    }

    /* ------------------------------ 数据源 ------------------------------ */

    @Test
    @DisplayName("health：无需鉴权，返回服务与数据目录信息")
    void health_endpoint() throws Exception {
        JsonNode response = getJson("/api/health");
        assertEquals("00000", response.path("code").asText());
        assertTrue(response.path("data").path("ok").asBoolean());
        assertEquals(DATA_DIR.toAbsolutePath().normalize().toString(), response.path("data").path("dataDir").asText());
    }

    @Test
    @DisplayName("数据源：注册/列表/详情/测试/更新/删除；内置 demo 常驻")
    void datasource_crud() throws Exception {
        String id = registerMemDatasource("crud-db", "svc_crud");
        JsonNode list = getJson("/api/datasources");
        assertEquals("00000", list.path("code").asText());
        assertTrue(list.path("data").path("total").asInt() >= 2); // demo + 新注册
        boolean hasDemo = false;
        for (JsonNode item : list.path("data").path("datasources")) {
            if ("demo".equals(item.path("id").asText())) {
                hasDemo = true;
            }
        }
        assertTrue(hasDemo);

        JsonNode detail = getJson("/api/datasources/" + id);
        assertEquals(id, detail.path("data").path("id").asText());
        assertEquals("custom", detail.path("data").path("type").asText());

        JsonNode tested = postJson("/api/datasources/" + id + "/test", "{}");
        assertEquals("00000", tested.path("code").asText());
        assertTrue(tested.path("data").path("ok").asBoolean());

        JsonNode updated = putJson("/api/datasources/" + id,
                "{\"type\":\"custom\",\"name\":\"crud-db-2\",\"jdbcUrl\":\"jdbc:h2:mem:svc_crud;DB_CLOSE_DELAY=-1\",\"user\":\"sa\"}");
        assertEquals("00000", updated.path("code").asText(), updated.toString());
        assertEquals("crud-db-2", updated.path("data").path("name").asText());

        JsonNode deleted = deleteJson("/api/datasources/" + id);
        assertEquals("00000", deleted.path("code").asText(), deleted.toString());
        JsonNode missing = getJson("/api/datasources/" + id);
        assertEquals("40000", missing.path("code").asText());
    }

    @Test
    @DisplayName("数据源密码：未勾选 savePassword 不落盘；勾选后 connections.json 才有密码")
    void password_persistence_follows_save_password_flag() throws Exception {
        String plain = registerMemDatasource("nopwd-db", "svc_nopwd");
        assertFalse(Files.readString(DATA_DIR.resolve("connections.json"), StandardCharsets.UTF_8)
                .contains("secret-not-saved"));

        String withPwd = "{\"type\":\"custom\",\"name\":\"pwd-db\",\"jdbcUrl\":\"jdbc:h2:mem:svc_pwd;DB_CLOSE_DELAY=-1\","
                + "\"user\":\"sa\",\"password\":\"secret-saved\",\"savePassword\":true}";
        JsonNode response = postJson("/api/datasources", json(withPwd));
        assertEquals("00000", response.path("code").asText(), response.toString());
        String persisted = Files.readString(DATA_DIR.resolve("connections.json"), StandardCharsets.UTF_8);
        assertTrue(persisted.contains("secret-saved"));
        assertFalse(persisted.contains("secret-not-saved"));
        assertTrue(getJson("/api/datasources").path("data").path("datasources").toString().contains(plain));
    }

    @Test
    @DisplayName("内置 H2 demo：注册返 demo，可直接浏览元数据与数据")
    void h2_demo_datasource_is_builtin() throws Exception {
        JsonNode response = postJson("/api/datasources", "{\"type\":\"h2-demo\",\"name\":\"演示\"}");
        assertEquals("00000", response.path("code").asText());
        assertEquals("demo", response.path("data").path("id").asText());

        JsonNode namespaces = getJson("/api/datasources/demo/namespaces");
        assertEquals("00000", namespaces.path("code").asText());
        JsonNode tables = getJson("/api/datasources/demo/tables");
        assertEquals("00000", tables.path("code").asText());
        assertTrue(tables.path("data").path("total").asInt() >= 4);

        JsonNode detail = getJson("/api/datasources/demo/table-detail?table=orders");
        assertEquals("00000", detail.path("code").asText());
        assertTrue(detail.path("data").path("columns").size() >= 5);
        JsonNode ddl = getJson("/api/datasources/demo/ddl?table=orders");
        assertEquals("00000", ddl.path("code").asText());
        assertTrue(ddl.path("data").path("ddl").asText().toUpperCase().contains("CREATE TABLE"));
    }

    @Test
    @DisplayName("数据浏览：limit=0 不分页返回全部（total 保留、paged=false）")
    void data_limit_zero_returns_all_rows() throws Exception {
        String id = registerMemDatasource("data-db", "svc_data");
        execute(id, "CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(20))");
        execute(id, "INSERT INTO items (id, name) VALUES (1,'a'),(2,'b'),(3,'c')");
        JsonNode page = getJson("/api/datasources/" + id + "/data?table=items&limit=2");
        assertEquals(2, page.path("data").path("rows").size());
        JsonNode all = getJson("/api/datasources/" + id + "/data?table=items&limit=0");
        assertEquals("00000", all.path("code").asText(), all.toString());
        assertEquals(3, all.path("data").path("rows").size());
        assertEquals(3, all.path("data").path("total").asInt());
        assertFalse(all.path("data").path("paged").asBoolean());
        assertFalse(all.path("data").path("truncated").asBoolean());
    }

    /* ------------------------------ 查询 / 写入 / 行编辑 ------------------------------ */

    @Test
    @DisplayName("query：只读查询返回行；写 SQL 被拒绝")
    void query_readonly() throws Exception {
        String id = registerMemDatasource("query-db", "svc_query");
        execute(id, "CREATE TABLE q (id INT PRIMARY KEY, v VARCHAR(10))");
        execute(id, "INSERT INTO q (id, v) VALUES (1,'x'),(2,'y')");
        JsonNode ok = postJson("/api/datasources/" + id + "/query", "{\"sql\":\"SELECT id, v FROM q ORDER BY id\"}");
        assertEquals("00000", ok.path("code").asText(), ok.toString());
        assertEquals(2, ok.path("data").path("rowCount").asInt());
        JsonNode rejected = postJson("/api/datasources/" + id + "/query", "{\"sql\":\"DELETE FROM q\"}");
        assertEquals("40000", rejected.path("code").asText());
    }

    @Test
    @DisplayName("execute：confirmed 缺失拒绝；confirmed=true 执行 DDL/DML")
    void execute_requires_confirmation() throws Exception {
        String id = registerMemDatasource("exec-db", "svc_exec");
        JsonNode noConfirm = postJson("/api/datasources/" + id + "/execute",
                "{\"sql\":\"CREATE TABLE e (id INT PRIMARY KEY)\"}");
        assertEquals("40000", noConfirm.path("code").asText());
        assertTrue(noConfirm.path("info").asText().contains("确认"));
        execute(id, "CREATE TABLE e (id INT PRIMARY KEY)");
        JsonNode insert = postJson("/api/datasources/" + id + "/execute",
                "{\"sql\":\"INSERT INTO e (id) VALUES (1)\",\"confirmed\":true}");
        assertEquals("00000", insert.path("code").asText());
        assertEquals(1, insert.path("data").path("affectedRows").asInt());
    }

    @Test
    @DisplayName("行 CRUD：insert/update/delete + generatedKeys；无主键表拒绝")
    void row_crud_and_primary_key_guard() throws Exception {
        String id = registerMemDatasource("row-db", "svc_row");
        execute(id, "CREATE TABLE r (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(30), age INT)");
        JsonNode inserted = postJson("/api/datasources/" + id + "/rows/insert",
                "{\"table\":\"r\",\"values\":{\"name\":\"alice\",\"age\":18},\"confirmed\":true}");
        assertEquals("00000", inserted.path("code").asText(), inserted.toString());
        assertEquals(1, inserted.path("data").path("affectedRows").asInt());
        int pk = inserted.path("data").path("generatedKeys").get(0).asInt();

        JsonNode updated = postJson("/api/datasources/" + id + "/rows/update",
                "{\"table\":\"r\",\"pk\":{\"id\":" + pk + "},\"changes\":{\"name\":\"bob\"},\"confirmed\":true}");
        assertEquals("00000", updated.path("code").asText(), updated.toString());
        assertEquals(1, updated.path("data").path("affectedRows").asInt());

        JsonNode deleted = postJson("/api/datasources/" + id + "/rows/delete",
                "{\"table\":\"r\",\"pk\":{\"id\":" + pk + "},\"confirmed\":true}");
        assertEquals("00000", deleted.path("code").asText());
        assertEquals(1, deleted.path("data").path("affectedRows").asInt());

        execute(id, "CREATE TABLE nopk (name VARCHAR(20))");
        JsonNode rejected = postJson("/api/datasources/" + id + "/rows/delete",
                "{\"table\":\"nopk\",\"pk\":{\"name\":\"x\"},\"confirmed\":true}");
        assertEquals("40000", rejected.path("code").asText());
        assertTrue(rejected.path("info").asText().contains("没有主键"));
    }

    @Test
    @DisplayName("编辑数据源未提供密码：保留已保存密码，不静默清空（断开后仍能连）")
    void edit_without_password_preserves_saved_password() throws Exception {
        String dbUrl = "jdbc:h2:file:" + DATA_DIR.resolve("pwdb").toString().replace('\\', '/')
                + ";DB_CLOSE_ON_EXIT=FALSE";
        try (java.sql.Connection connection = java.sql.DriverManager.getConnection(dbUrl, "sa", "");
             java.sql.Statement statement = connection.createStatement()) {
            statement.execute("ALTER USER SA SET PASSWORD 'pw-preserved'");
        }
        String body = "{\"type\":\"custom\",\"name\":\"pw-db\",\"jdbcUrl\":\"" + dbUrl
                + "\",\"user\":\"sa\",\"password\":\"pw-preserved\",\"savePassword\":true}";
        JsonNode registered = postJson("/api/datasources", body);
        assertEquals("00000", registered.path("code").asText(), registered.toString());
        String id = registered.path("data").path("id").asText();
        assertTrue(registered.path("data").path("passwordSaved").asBoolean());
        String persisted = Files.readString(DATA_DIR.resolve("connections.json"), StandardCharsets.UTF_8);
        assertTrue(persisted.contains("pw-preserved"));

        // 编辑时只改名称，不提供密码、不勾选保存密码
        JsonNode edited = putJson("/api/datasources/" + id,
                "{\"type\":\"custom\",\"name\":\"pw-db-edit\",\"jdbcUrl\":\"" + dbUrl + "\",\"user\":\"sa\"}");
        assertEquals("00000", edited.path("code").asText(), edited.toString());
        assertTrue(edited.path("data").path("passwordSaved").asBoolean(), "未提供密码时不应清空已保存密码");
        String persistedAfterEdit = Files.readString(DATA_DIR.resolve("connections.json"), StandardCharsets.UTF_8);
        assertTrue(persistedAfterEdit.contains("pw-preserved"));

        // 清掉进程内缓存后仍能连（说明持久化密码还在）
        postJson("/api/agent/datasources/" + id + "/disconnect", "{}");
        JsonNode tested = postJson("/api/datasources/" + id + "/test", "{}");
        assertEquals("00000", tested.path("code").asText(), tested.toString());
        assertTrue(tested.path("data").path("ok").asBoolean(), tested.toString());
    }

    /* ------------------------------ Agent ------------------------------ */

    @Test
    @DisplayName("Agent：注册/清单/schema/紧凑 query")
    void agent_register_schema_query() throws Exception {
        JsonNode registered = postJson("/api/agent/datasources",
                "{\"type\":\"custom\",\"name\":\"agent-db\",\"jdbcUrl\":\"jdbc:h2:mem:svc_agent;DB_CLOSE_DELAY=-1\",\"user\":\"sa\"}");
        assertEquals("00000", registered.path("code").asText(), registered.toString());
        String id = registered.path("data").path("id").asText();
        execute(id, "CREATE TABLE a (id INT PRIMARY KEY, label VARCHAR(20))");
        execute(id, "INSERT INTO a (id, label) VALUES (1,'one'),(2,'two')");

        JsonNode list = getJson("/api/agent/datasources");
        assertEquals("00000", list.path("code").asText());
        assertTrue(list.path("data").path("total").asInt() >= 2);

        JsonNode schema = getJson("/api/agent/datasources/" + id + "/schema");
        assertEquals("00000", schema.path("code").asText(), schema.toString());
        assertTrue(schema.path("data").path("tableCount").asInt() >= 1);
        JsonNode table = schema.path("data").path("tables").get(0);
        assertTrue(table.path("columns").size() >= 2);

        JsonNode query = postJson("/api/agent/datasources/" + id + "/query",
                "{\"sql\":\"SELECT id, label FROM a ORDER BY id\",\"maxRows\":10}");
        assertEquals("00000", query.path("code").asText(), query.toString());
        assertEquals(2, query.path("data").path("rowCount").asInt());
        assertTrue(query.path("data").path("columns").isArray());
        assertTrue(query.path("data").path("rows").isArray());
        assertEquals(1, query.path("data").path("rows").get(0).get(0).asInt());
    }

    @Test
    @DisplayName("Agent 增量：register → read 全量/翻页/cursor/hasMore；未注册拒绝")
    void agent_incremental_register_and_read() throws Exception {
        String id = registerMemDatasource("inc-db", "svc_inc");
        execute(id, "CREATE TABLE events (id INT PRIMARY KEY, name VARCHAR(20))");
        execute(id, "INSERT INTO events (id, name) VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')");

        JsonNode registered = postJson("/api/agent/datasources/" + id + "/incremental/register",
                "{\"table\":\"events\",\"watermarkColumn\":\"id\",\"primaryKey\":\"id\"}");
        assertEquals("00000", registered.path("code").asText(), registered.toString());
        assertTrue(registered.path("data").path("watermarkColumn").asText().equalsIgnoreCase("id"));

        JsonNode first = getJson("/api/agent/datasources/" + id + "/incremental/read?table=events&limit=2");
        assertEquals("00000", first.path("code").asText(), first.toString());
        assertEquals(2, first.path("data").path("rowCount").asInt());
        assertTrue(first.path("data").path("hasMore").asBoolean());
        assertEquals(2, first.path("data").path("nextCursor").asInt());

        JsonNode second = getJson("/api/agent/datasources/" + id
                + "/incremental/read?table=events&since=2&limit=3");
        assertEquals(3, second.path("data").path("rowCount").asInt());
        assertFalse(second.path("data").path("hasMore").asBoolean());
        assertEquals(5, second.path("data").path("nextCursor").asInt());

        JsonNode unregistered = getJson("/api/agent/datasources/" + id + "/incremental/read?table=events2");
        assertEquals("40000", unregistered.path("code").asText());
    }

    @Test
    @DisplayName("Agent 行 CRUD：insert/update/delete（allowWrite + confirmed）")
    void agent_row_crud() throws Exception {
        String id = registerMemDatasource("agent-row-db", "svc_agent_row");
        execute(id, "CREATE TABLE ar (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))");
        JsonNode inserted = postJson("/api/agent/datasources/" + id + "/rows/insert",
                "{\"table\":\"ar\",\"values\":{\"name\":\"a\"},\"confirmed\":true}");
        assertEquals("00000", inserted.path("code").asText(), inserted.toString());
        int pk = inserted.path("data").path("generatedKeys").get(0).asInt();
        JsonNode updated = postJson("/api/agent/datasources/" + id + "/rows/update",
                "{\"table\":\"ar\",\"pk\":{\"id\":" + pk + "},\"changes\":{\"name\":\"b\"},\"confirmed\":true}");
        assertEquals("00000", updated.path("code").asText(), updated.toString());
        JsonNode deleted = postJson("/api/agent/datasources/" + id + "/rows/delete",
                "{\"table\":\"ar\",\"pk\":{\"id\":" + pk + "},\"confirmed\":true}");
        assertEquals("00000", deleted.path("code").asText(), deleted.toString());
        assertEquals(1, deleted.path("data").path("affectedRows").asInt());
    }

    @Test
    @DisplayName("Agent 增量：标识符必须来自真实元数据（未知水位列/表拒绝）")
    void agent_incremental_validates_identifiers() throws Exception {
        String id = registerMemDatasource("inc-bad-db", "svc_inc_bad");
        execute(id, "CREATE TABLE e2 (id INT PRIMARY KEY)");
        JsonNode badColumn = postJson("/api/agent/datasources/" + id + "/incremental/register",
                "{\"table\":\"e2\",\"watermarkColumn\":\"no_such\",\"primaryKey\":\"id\"}");
        assertEquals("40000", badColumn.path("code").asText());
        assertTrue(badColumn.path("info").asText().contains("列不存在"));
        JsonNode badTable = postJson("/api/agent/datasources/" + id + "/incremental/register",
                "{\"table\":\"ghost\",\"watermarkColumn\":\"id\",\"primaryKey\":\"id\"}");
        assertEquals("40000", badTable.path("code").asText());
    }
}



