package com.jnf.dbservice;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Connection;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 数据源下的元数据、数据浏览、只读查询、写操作与行级编辑。 */
@RestController
@RequestMapping("/api/datasources/{id}")
public class DataController {

    @FunctionalInterface
    interface SqlWork {
        Map<String, Object> apply(Connection connection) throws Exception;
    }

    private final DataSourceRegistry registry;
    private final AppProperties properties;

    public DataController(DataSourceRegistry registry, AppProperties properties) {
        this.registry = registry;
        this.properties = properties;
    }

    /* ------------------------------ 元数据 ------------------------------ */

    @GetMapping("/namespaces")
    public ApiResult namespaces(@PathVariable String id) {
        return ApiResult.ok(withConnection(id, DbSupport::namespaces));
    }

    @GetMapping("/tables")
    public ApiResult tables(@PathVariable String id, @RequestParam(required = false) String schema) {
        return ApiResult.ok(withConnection(id, con -> {
            List<Map<String, Object>> tables = DbSupport.tables(con, schema);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("tables", tables);
            body.put("total", tables.size());
            body.put("schema", schema == null ? "" : schema);
            return body;
        }));
    }

    @GetMapping("/table-detail")
    public ApiResult tableDetail(@PathVariable String id, @RequestParam(required = false) String schema,
                                 @RequestParam String table) {
        return ApiResult.ok(withConnection(id, con -> DbSupport.tableDetail(con, schema, table)));
    }

    @GetMapping("/ddl")
    public ApiResult ddl(@PathVariable String id, @RequestParam(required = false) String schema,
                         @RequestParam String table) {
        return ApiResult.ok(withConnection(id, con -> DbSupport.ddl(con, schema, table)));
    }

    /* ------------------------------ 数据 ------------------------------ */

    @GetMapping("/data")
    public ApiResult data(@PathVariable String id,
                          @RequestParam(required = false) String schema,
                          @RequestParam String table,
                          @RequestParam(defaultValue = "100") int limit,
                          @RequestParam(defaultValue = "0") int offset,
                          @RequestParam(required = false) String orderBy,
                          @RequestParam(defaultValue = "false") boolean desc,
                          @RequestParam(required = false) String filter) {
        int safeLimit = Math.min(500, Math.max(0, limit));
        int safeOffset = safeLimit <= 0 ? 0 : Math.min(1_000_000, Math.max(0, offset));
        return ApiResult.ok(withConnection(id, con -> DbSupport.tableData(con, schema, table,
                safeLimit, safeOffset, orderBy == null ? "" : orderBy, desc, filter == null ? "" : filter)));
    }

    @PostMapping("/query")
    public ApiResult query(@PathVariable String id, @RequestBody Map<String, Object> body) {
        String sql = DbSupport.singleStatement(DataSourceController.text(body, "sql"));
        if (!DbSupport.isReadOnly(sql)) {
            throw new IllegalArgumentException("query 只接受只读 SQL（首关键字 " + DbSupport.firstKeyword(sql)
                    + " 不被允许）；写操作请用 execute");
        }
        int maxRows = clampInt(DataSourceController.text(body, "maxRows"), properties.getMaxRows(), 1, 500);
        String schema = DataSourceController.text(body, "schema");
        return ApiResult.ok(withConnection(id, con -> {
            DbSupport.applySchema(con, DbSupport.resolveSchema(con, schema));
            Map<String, Object> result = DbSupport.query(con, sql, maxRows);
            result.put("sql", sql);
            result.put("schema", schema);
            return result;
        }));
    }

    @PostMapping("/execute")
    public ApiResult execute(@PathVariable String id, @RequestBody Map<String, Object> body) {
        requireWriteGate(DataSourceController.bool(body, "confirmed"));
        String sql = DbSupport.singleStatement(DataSourceController.text(body, "sql"));
        if (DbSupport.isReadOnly(sql)) {
            throw new IllegalArgumentException("execute 只用于写/DDL；只读查询请用 query");
        }
        return ApiResult.ok(withConnection(id, con -> {
            long started = System.currentTimeMillis();
            int affected;
            try (Statement statement = con.createStatement()) {
                statement.setQueryTimeout(15);
                affected = statement.executeUpdate(sql);
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("sql", sql);
            result.put("affectedRows", affected);
            result.put("elapsedMs", System.currentTimeMillis() - started);
            return result;
        }));
    }

    @PostMapping("/explain")
    public ApiResult explain(@PathVariable String id, @RequestBody Map<String, Object> body) {
        String sql = DbSupport.singleStatement(DataSourceController.text(body, "sql"));
        String keyword = DbSupport.firstKeyword(sql);
        if (!List.of("SELECT", "WITH", "VALUES").contains(keyword)) {
            throw new IllegalArgumentException("explain 只接受 SELECT/WITH/VALUES 查询（首关键字 " + keyword + " 不被允许）");
        }
        int maxRows = clampInt(DataSourceController.text(body, "maxRows"), 200, 1, 500);
        String schema = DataSourceController.text(body, "schema");
        return ApiResult.ok(withConnection(id, con -> {
            DbSupport.applySchema(con, DbSupport.resolveSchema(con, schema));
            Map<String, Object> result = DbSupport.query(con, "EXPLAIN " + sql, maxRows);
            result.put("plan", result.get("rows"));
            result.put("text", "");
            result.put("engine", DbSupport.dialect(con));
            result.put("sql", sql);
            return result;
        }));
    }

    /* ------------------------------ 行级编辑 ------------------------------ */

    @PostMapping("/rows/insert")
    public ApiResult rowInsert(@PathVariable String id, @RequestBody Map<String, Object> body) {
        requireWriteGate(DataSourceController.bool(body, "confirmed"));
        String schema = DataSourceController.text(body, "schema");
        String table = DataSourceController.text(body, "table");
        Map<String, Object> values = mapArg(body, "values");
        return ApiResult.ok(withConnection(id, con -> DbSupport.rowInsert(con, schema, table, values)));
    }

    @PostMapping("/rows/update")
    public ApiResult rowUpdate(@PathVariable String id, @RequestBody Map<String, Object> body) {
        requireWriteGate(DataSourceController.bool(body, "confirmed"));
        String schema = DataSourceController.text(body, "schema");
        String table = DataSourceController.text(body, "table");
        Map<String, Object> pk = mapArg(body, "pk");
        Map<String, Object> changes = mapArg(body, "changes");
        return ApiResult.ok(withConnection(id, con -> DbSupport.rowUpdate(con, schema, table, pk, changes)));
    }

    @PostMapping("/rows/delete")
    public ApiResult rowDelete(@PathVariable String id, @RequestBody Map<String, Object> body) {
        requireWriteGate(DataSourceController.bool(body, "confirmed"));
        String schema = DataSourceController.text(body, "schema");
        String table = DataSourceController.text(body, "table");
        Map<String, Object> pk = mapArg(body, "pk");
        return ApiResult.ok(withConnection(id, con -> DbSupport.rowDelete(con, schema, table, pk)));
    }

    /* ------------------------------ 工具 ------------------------------ */

    private void requireWriteGate(boolean confirmed) {
        if (!properties.isAllowWrite()) {
            throw new ApiException("40000", "写操作被禁用：请以 db-service.allow-write=true 启动服务后重试");
        }
        if (!confirmed) {
            throw new IllegalArgumentException("写操作需要确认：请求体传 confirmed=true");
        }
    }

    Map<String, Object> withConnection(String id, SqlWork work) {
        DataSourceRegistry.DbConnection connection = registry.require(id);
        try (Connection con = registry.open(connection)) {
            Map<String, Object> result = new LinkedHashMap<>(work.apply(con));
            result.putIfAbsent("datasourceId", connection.id());
            return result;
        } catch (IllegalArgumentException | ApiException error) {
            throw error;
        } catch (Exception error) {
            throw new ApiException("40000", "数据库操作失败: " + DataSourceRegistry.rootMessage(error));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapArg(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        if (value == null) {
            return Map.of();
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            map.forEach((mapKey, mapValue) -> result.put(String.valueOf(mapKey), mapValue));
            return result;
        }
        throw new IllegalArgumentException(key + " 必须是 JSON 对象");
    }

    private static int clampInt(String raw, int defaultValue, int min, int max) {
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        try {
            return Math.max(min, Math.min(max, Integer.parseInt(raw.trim())));
        } catch (NumberFormatException error) {
            return defaultValue;
        }
    }
}
