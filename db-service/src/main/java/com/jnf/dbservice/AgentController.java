package com.jnf.dbservice;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Connection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 面向 Agent 的紧凑接口：注册、清单、schema 摘要、只读查询、增量注册/读取。
 * <p>返回体积优先（行数据用数组），适合直接喂给模型上下文。
 */
@RestController
@RequestMapping("/api/agent/datasources")
public class AgentController {

    private static final int SCHEMA_TABLE_LIMIT = 200;

    private final DataSourceRegistry registry;
    private final DataSourceController dataSourceController;
    private final DataController dataController;
    private final IncrementalService incrementalService;

    public AgentController(DataSourceRegistry registry, DataSourceController dataSourceController,
                           DataController dataController, IncrementalService incrementalService) {
        this.registry = registry;
        this.dataSourceController = dataSourceController;
        this.dataController = dataController;
        this.incrementalService = incrementalService;
    }

    /** 注册数据源（等同平台侧创建）：返回 {id,name,type,kind}。 */
    @PostMapping
    public ApiResult register(@RequestBody Map<String, Object> body) {
        Map<String, Object> view = dataSourceController.register(body);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", view.get("id"));
        result.put("name", view.get("name"));
        result.put("type", view.get("type"));
        result.put("kind", view.get("kind"));
        return ApiResult.ok(result);
    }

    /** 数据源清单（紧凑）：[{id,name,type}]。 */
    @GetMapping
    public ApiResult list() {
        List<Map<String, Object>> items = new ArrayList<>();
        for (DataSourceRegistry.DbConnection connection : registry.list()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", connection.id());
            item.put("name", connection.name());
            item.put("type", connection.type());
            items.add(item);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("datasources", items);
        result.put("total", items.size());
        return ApiResult.ok(result);
    }

    /** schema 摘要：表 + 列（名称/类型/可空/主键/自增/注释），供 Agent 规划 SQL。 */
    @GetMapping("/{id}/schema")
    public ApiResult schema(@PathVariable String id) {
        Map<String, Object> result = dataController.withConnection(id, con -> {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("dialect", DbSupport.dialect(con));
            body.put("namespaces", DbSupport.namespaces(con).get("items"));
            List<Map<String, Object>> tableSummaries = new ArrayList<>();
            List<Map<String, Object>> tables = DbSupport.tables(con);
            for (Map<String, Object> table : tables) {
                if (tableSummaries.size() >= SCHEMA_TABLE_LIMIT) {
                    break;
                }
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("name", table.get("name"));
                summary.put("type", table.get("type"));
                summary.put("rowCount", table.get("rows"));
                List<Map<String, Object>> columns = new ArrayList<>();
                try {
                    Map<String, Object> detail = DbSupport.tableDetail(con, null, String.valueOf(table.get("name")));
                    summary.put("comment", detail.get("comment"));
                    for (Object element : (List<?>) detail.get("columns")) {
                        if (element instanceof Map<?, ?> column) {
                            Map<String, Object> compact = new LinkedHashMap<>();
                            compact.put("name", column.get("name"));
                            compact.put("type", column.get("type"));
                            compact.put("nullable", column.get("nullable"));
                            compact.put("primaryKey", column.get("primaryKey"));
                            compact.put("autoIncrement", column.get("autoIncrement"));
                            Object comment = column.get("comment");
                            if (comment != null && !String.valueOf(comment).isBlank()) {
                                compact.put("comment", comment);
                            }
                            columns.add(compact);
                        }
                    }
                } catch (Exception ignored) {
                    // 单表结构失败不影响整体 schema
                }
                summary.put("columns", columns);
                tableSummaries.add(summary);
            }
            body.put("tables", tableSummaries);
            body.put("tableCount", tableSummaries.size());
            return body;
        });
        result.put("datasourceId", id);
        return ApiResult.ok(result);
    }

    /** 只读查询（紧凑结果）：{columns:[名], rows:[[...]], rowCount, truncated, elapsedMs}。 */
    @PostMapping("/{id}/query")
    public ApiResult query(@PathVariable String id, @RequestBody Map<String, Object> body) {
        String sql = DbSupport.singleStatement(DataSourceController.text(body, "sql"));
        if (!DbSupport.isReadOnly(sql)) {
            throw new IllegalArgumentException("只读接口：首关键字 " + DbSupport.firstKeyword(sql)
                    + " 不被允许（Agent 查询仅支持 SELECT/WITH/EXPLAIN/VALUES/SHOW/DESCRIBE）");
        }
        int maxRows = clampInt(DataSourceController.text(body, "maxRows"), 200, 1, 500);
        Map<String, Object> result = dataController.withConnection(id, con -> {
            Map<String, Object> queried = DbSupport.query(con, sql, maxRows);
            List<String> columns = new ArrayList<>();
            if (queried.get("columns") instanceof List<?> names) {
                for (Object name : names) {
                    columns.add(String.valueOf(name));
                }
            }
            List<List<Object>> rows = new ArrayList<>();
            if (queried.get("rows") instanceof List<?> rawRows) {
                for (Object element : rawRows) {
                    if (element instanceof Map<?, ?> row) {
                        List<Object> values = new ArrayList<>();
                        for (String column : columns) {
                            values.add(row.get(column));
                        }
                        rows.add(values);
                    }
                }
            }
            Map<String, Object> compact = new LinkedHashMap<>();
            compact.put("datasourceId", id);
            compact.put("sql", sql);
            compact.put("columns", columns);
            compact.put("rows", rows);
            compact.put("rowCount", rows.size());
            compact.put("truncated", queried.get("truncated"));
            compact.put("elapsedMs", queried.get("elapsedMs"));
            return compact;
        });
        return ApiResult.ok(result);
    }

    /** 增量注册：{table,watermarkColumn,primaryKey}。 */
    @PostMapping("/{id}/incremental/register")
    public ApiResult incrementalRegister(@PathVariable String id, @RequestBody Map<String, Object> body) {
        registry.require(id);
        return ApiResult.ok(incrementalService.register(id, body));
    }

    /**
     * 增量读取：?table=&amp;since=&amp;limit= → {rows,nextCursor,hasMore}。
     * <p>since 为空表示从最早开始；nextCursor 作为下一页的 since。
     */
    @GetMapping("/{id}/incremental/read")
    public ApiResult incrementalRead(@PathVariable String id,
                                     @RequestParam String table,
                                     @RequestParam(required = false) String since,
                                     @RequestParam(defaultValue = "200") int limit) {
        registry.require(id);
        return ApiResult.ok(incrementalService.read(id, table, since, limit));
    }

    /** Agent 行插入（allowWrite + confirmed；参数化、列白名单）。 */
    @PostMapping("/{id}/rows/insert")
    public ApiResult rowInsert(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return dataController.rowInsert(id, body);
    }

    /** Agent 行更新（pk 必须是完整主键；仅允许非主键列进 changes）。 */
    @PostMapping("/{id}/rows/update")
    public ApiResult rowUpdate(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return dataController.rowUpdate(id, body);
    }

    /** Agent 行删除（主键定位，无主键表拒绝）。 */
    @PostMapping("/{id}/rows/delete")
    public ApiResult rowDelete(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return dataController.rowDelete(id, body);
    }

    /** 断开数据源：清理进程内密码缓存（不删注册配置）。 */
    @PostMapping("/{id}/disconnect")
    public ApiResult disconnect(@PathVariable String id) {
        registry.disconnect(id);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("disconnected", true);
        return ApiResult.ok(result);
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

