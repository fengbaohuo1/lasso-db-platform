package com.jnf.dbservice;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 数据源注册与管理（平台前端用）：CRUD + 测试。 */
@RestController
@RequestMapping("/api/datasources")
public class DataSourceController {

    private final DataSourceRegistry registry;
    private final IncrementalConfigStore incrementalStore;

    public DataSourceController(DataSourceRegistry registry, IncrementalConfigStore incrementalStore) {
        this.registry = registry;
        this.incrementalStore = incrementalStore;
    }

    @GetMapping
    public ApiResult list() {
        List<Map<String, Object>> items = new ArrayList<>();
        for (DataSourceRegistry.DbConnection connection : registry.list()) {
            items.add(view(connection));
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("datasources", items);
        data.put("total", items.size());
        return ApiResult.ok(data);
    }

    @PostMapping
    public ApiResult create(@RequestBody Map<String, Object> body) {
        return ApiResult.ok(register(body));
    }

    @GetMapping("/{id}")
    public ApiResult get(@PathVariable String id) {
        return ApiResult.ok(view(registry.require(id)));
    }

    @PutMapping("/{id}")
    public ApiResult update(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return ApiResult.ok(updateDatasource(id, body));
    }

    @DeleteMapping("/{id}")
    public ApiResult delete(@PathVariable String id) {
        if ("demo".equals(id)) {
            throw new IllegalArgumentException("内置演示库不可删除");
        }
        List<ConnectionStore.StoredConnection> existing = new ArrayList<>(registry.stored());
        boolean removed = existing.removeIf(item -> item.id().equals(id));
        if (!removed) {
            throw new IllegalArgumentException("数据源不存在: " + id);
        }
        registry.store().save(existing);
        registry.evictPassword(id);
        incrementalStore.deleteDatasource(id);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("deleted", id);
        result.put("total", existing.size());
        return ApiResult.ok(result);
    }

    @PostMapping("/{id}/test")
    public ApiResult test(@PathVariable String id) {
        DataSourceRegistry.DbConnection connection = registry.require(id);
        Map<String, Object> result = new LinkedHashMap<>(registry.test(connection));
        result.put("datasourceId", connection.id());
        return ApiResult.ok(result);
    }

    /* ------------------------------ 内部逻辑 ------------------------------ */

    /** 注册：校验字段→连接测试→落盘（密码仅 savePassword=true 时持久化）。 */
    Map<String, Object> register(Map<String, Object> body) {
        boolean savePassword = bool(body, "savePassword");
        String name = text(body, "name");
        ConnectionSpec.Spec spec = ConnectionSpec.parse(body);
        if (spec.isDemo()) {
            return view(registry.demo());
        }
        if (name.isEmpty()) {
            name = spec.defaultName();
        }
        List<ConnectionStore.StoredConnection> existing = new ArrayList<>(registry.stored());
        if (existing.size() >= ConnectionStore.MAX_CONNECTIONS) {
            throw new IllegalArgumentException("最多注册 " + ConnectionStore.MAX_CONNECTIONS + " 个数据源，请先删除不用的");
        }
        String id = ConnectionStore.suggestId(name, existing);
        String password = spec.password() == null ? "" : spec.password();
        DataSourceRegistry.DbConnection candidate = candidate(id, name, spec, password);
        Map<String, Object> tested = registry.test(candidate);
        if (!Boolean.TRUE.equals(tested.get("ok"))) {
            throw new IllegalArgumentException("连接测试失败: " + tested.get("error"));
        }
        registry.cachePassword(candidate, password);
        existing.add(new ConnectionStore.StoredConnection(id, name, spec.type(), spec.host(), spec.port(),
                spec.database(), spec.jdbcUrl(), blankToNull(spec.user()), savePassword ? blankToNull(password) : null));
        registry.store().save(existing);
        return view(registry.require(id));
    }

    /** 更新：id 不可变；密码仅 savePassword=true 落盘，否则仅进程内缓存。 */
    Map<String, Object> updateDatasource(String id, Map<String, Object> body) {
        if ("demo".equals(id)) {
            throw new IllegalArgumentException("内置演示库不可修改");
        }
        ConnectionSpec.Spec spec = ConnectionSpec.parse(body);
        if (spec.isDemo()) {
            throw new IllegalArgumentException("不能把数据源改为内置演示库类型");
        }
        List<ConnectionStore.StoredConnection> existing = new ArrayList<>(registry.stored());
        int index = -1;
        for (int i = 0; i < existing.size(); i++) {
            if (existing.get(i).id().equals(id)) {
                index = i;
                break;
            }
        }
        if (index < 0) {
            throw new IllegalArgumentException("数据源不存在: " + id);
        }
        ConnectionStore.StoredConnection current = existing.get(index);
        boolean savePassword = bool(body, "savePassword");
        String name = text(body, "name");
        if (name.isEmpty()) {
            name = current.name();
        }
        String provided = spec.password() == null ? "" : spec.password();
        boolean passwordProvided = !provided.isEmpty();
        String existingPassword = current.password();
        // 未提供密码时沿用原有持久化密码，避免“编辑名称/端口等”时静默清空密码（严重：会导致后续连不上）
        String effectivePassword = passwordProvided ? provided : existingPassword;
        String persistedPassword = passwordProvided
                ? (savePassword ? blankToNull(provided) : null)
                : existingPassword;
        DataSourceRegistry.DbConnection candidate = candidate(id, name, spec, effectivePassword);
        Map<String, Object> tested = registry.test(candidate);
        if (!Boolean.TRUE.equals(tested.get("ok"))) {
            throw new IllegalArgumentException("连接测试失败: " + tested.get("error"));
        }
        registry.cachePassword(candidate, effectivePassword);
        existing.set(index, new ConnectionStore.StoredConnection(id, name, spec.type(), spec.host(), spec.port(),
                spec.database(), spec.jdbcUrl(), blankToNull(spec.user()), persistedPassword));
        registry.store().save(existing);
        return view(registry.require(id));
    }

    private static DataSourceRegistry.DbConnection candidate(String id, String name, ConnectionSpec.Spec spec,
                                                             String password) {
        return new DataSourceRegistry.DbConnection(id, name, "stored", spec.type(), spec.host(), spec.port(),
                spec.database(), spec.jdbcUrl(), blankToNull(spec.user()), blankToNull(password));
    }

    static Map<String, Object> view(DataSourceRegistry.DbConnection connection) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", connection.id());
        item.put("name", connection.name());
        item.put("kind", connection.kind());
        item.put("type", connection.type());
        item.put("typeLabel", ConnectionSpec.label(connection.type()));
        item.put("host", connection.host());
        item.put("port", connection.port());
        item.put("database", connection.database());
        item.put("jdbcUrl", connection.jdbcUrl());
        item.put("user", connection.user());
        item.put("passwordSaved", connection.hasSavedPassword());
        return item;
    }

    static String text(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value == null ? "" : String.valueOf(value).trim();
    }

    static boolean bool(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        if (value instanceof Boolean flag) {
            return flag;
        }
        return value != null && "true".equalsIgnoreCase(String.valueOf(value).trim());
    }

    static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}

