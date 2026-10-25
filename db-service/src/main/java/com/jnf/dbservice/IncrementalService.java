package com.jnf.dbservice;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Time;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 增量读取：注册（表 + 水位列 + 主键）与按水位翻页读取。
 * <p>SQL 模板固定为 {@code SELECT * FROM <table> [WHERE <watermark> > ?] ORDER BY <watermark> ASC LIMIT ?}，
 * 表/列名必须来自真实元数据（白名单校验后按驱动规则加引号），值全部参数绑定。
 */
@Service
public class IncrementalService {

    private final DataSourceRegistry registry;
    private final IncrementalConfigStore store;
    private final AppProperties properties;

    public IncrementalService(DataSourceRegistry registry, IncrementalConfigStore store, AppProperties properties) {
        this.registry = registry;
        this.store = store;
        this.properties = properties;
    }

    /** 注册增量表：校验表/水位列/主键真实存在，配置落盘 data/incremental.json。 */
    public Map<String, Object> register(String datasourceId, Map<String, Object> body) {
        String rawTable = text(body, "table");
        String watermark = text(body, "watermarkColumn");
        String primaryKey = text(body, "primaryKey");
        if (rawTable.isEmpty()) {
            throw new IllegalArgumentException("table 不能为空");
        }
        if (watermark.isEmpty()) {
            throw new IllegalArgumentException("watermarkColumn 不能为空");
        }
        if (primaryKey.isEmpty()) {
            throw new IllegalArgumentException("primaryKey 不能为空");
        }
        DataSourceRegistry.DbConnection connection = registry.require(datasourceId);
        try (Connection con = registry.open(connection)) {
            Map<String, Object> detail = DbSupport.tableDetail(con, null, rawTable);
            String table = String.valueOf(detail.get("table"));
            List<Map<String, Object>> columns = columnsOf(detail);
            String canonicalWatermark = canonicalColumn(columns, watermark);
            String canonicalPrimaryKey = canonicalColumn(columns, primaryKey);
            Map<String, Object> config = new LinkedHashMap<>();
            config.put("watermarkColumn", canonicalWatermark);
            config.put("primaryKey", canonicalPrimaryKey);
            config.put("updatedAt", OffsetDateTime.now().toString());
            store.put(connection.id(), table, config);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("datasourceId", connection.id());
            result.put("table", table);
            result.put("watermarkColumn", canonicalWatermark);
            result.put("primaryKey", canonicalPrimaryKey);
            result.put("registered", true);
            return result;
        } catch (SQLException error) {
            throw new ApiException("40000", "数据库操作失败: " + DataSourceRegistry.rootMessage(error));
        }
    }

    /**
     * 增量读取：since 为空表示从最早记录开始；返回 {rows,nextCursor,hasMore} 等。
     * <p>nextCursor 为最后一行水位值，下次以 since=nextCursor 继续。
     */
    public Map<String, Object> read(String datasourceId, String rawTable, String since, int requestedLimit) {
        if (rawTable == null || rawTable.isBlank()) {
            throw new IllegalArgumentException("table 不能为空");
        }
        int limit = Math.max(1, Math.min(properties.getIncrementalMaxLimit(),
                requestedLimit <= 0 ? 200 : requestedLimit));
        DataSourceRegistry.DbConnection connection = registry.require(datasourceId);
        try (Connection con = registry.open(connection)) {
            Map<String, Object> detail = DbSupport.tableDetail(con, null, rawTable);
            String table = String.valueOf(detail.get("table"));
            Map<String, Object> config = store.get(connection.id(), table);
            if (config == null) {
                throw new ApiException("40000", "增量表未注册: " + table
                        + "（先 POST /api/agent/datasources/" + connection.id()
                        + "/incremental/register {table,watermarkColumn,primaryKey}）");
            }
            List<Map<String, Object>> columns = columnsOf(detail);
            String watermark = canonicalColumn(columns, String.valueOf(config.get("watermarkColumn")));
            String primaryKey = canonicalColumn(columns, String.valueOf(config.get("primaryKey")));
            String type = columnType(columns, watermark);
            boolean hasSince = since != null && !since.isBlank();
            Object boundSince = hasSince ? convertSince(type, since.trim()) : null;

            String sql = "SELECT * FROM " + DbSupport.qualify(con, null, table)
                    + (hasSince ? " WHERE " + DbSupport.quote(con, watermark) + " > ?" : "")
                    + " ORDER BY " + DbSupport.quote(con, watermark) + " ASC LIMIT ?";
            List<Map<String, Object>> rows = new ArrayList<>();
            boolean hasMore = false;
            try (PreparedStatement statement = con.prepareStatement(sql)) {
                int index = 1;
                if (hasSince) {
                    statement.setObject(index++, boundSince);
                }
                statement.setInt(index, limit + 1); // 多取 1 行判断是否还有更多
                try (ResultSet rs = statement.executeQuery()) {
                    ResultSetMetaData meta = rs.getMetaData();
                    while (rs.next()) {
                        if (rows.size() >= limit) {
                            hasMore = true;
                            break;
                        }
                        Map<String, Object> row = new LinkedHashMap<>();
                        for (int i = 1; i <= meta.getColumnCount(); i++) {
                            row.put(meta.getColumnLabel(i), display(rs, i));
                        }
                        rows.add(row);
                    }
                }
            }
            Object nextCursor = rows.isEmpty() ? null : rows.get(rows.size() - 1).get(watermark);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("datasourceId", connection.id());
            result.put("table", table);
            result.put("watermarkColumn", watermark);
            result.put("primaryKey", primaryKey);
            result.put("since", hasSince ? since.trim() : null);
            result.put("limit", limit);
            result.put("rowCount", rows.size());
            result.put("hasMore", hasMore);
            result.put("nextCursor", nextCursor);
            result.put("rows", rows);
            return result;
        } catch (SQLException error) {
            throw new ApiException("40000", "数据库操作失败: " + DataSourceRegistry.rootMessage(error));
        }
    }

    /* ------------------------------ 工具 ------------------------------ */

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> columnsOf(Map<String, Object> tableDetail) {
        Object columns = tableDetail.get("columns");
        return columns instanceof List<?> list ? (List<Map<String, Object>>) list : List.of();
    }

    private static String canonicalColumn(List<Map<String, Object>> columns, String requested) {
        for (Map<String, Object> column : columns) {
            String name = String.valueOf(column.get("name"));
            if (name.equalsIgnoreCase(requested)) {
                return name;
            }
        }
        throw new IllegalArgumentException("列不存在: " + requested + "（可用: "
                + String.join(", ", columns.stream().map(column -> String.valueOf(column.get("name"))).toList()) + "）");
    }

    private static String columnType(List<Map<String, Object>> columns, String name) {
        for (Map<String, Object> column : columns) {
            if (String.valueOf(column.get("name")).equalsIgnoreCase(name)) {
                return String.valueOf(column.get("type")).toUpperCase(java.util.Locale.ROOT);
            }
        }
        return "";
    }

    /** 水位值按列类型转换（时间/数字/字符串），避免字符串与时间列比较失败。 */
    private static Object convertSince(String type, String since) {
        try {
            if (type.contains("TIMESTAMP") || type.contains("DATETIME")) {
                String normalized = since.replace('T', ' ');
                if (normalized.length() == 10) {
                    normalized = normalized + " 00:00:00";
                }
                return Timestamp.valueOf(normalized);
            }
            if (type.equals("DATE")) {
                return java.sql.Date.valueOf(since);
            }
            if (type.equals("TIME")) {
                return Time.valueOf(since);
            }
            if (type.contains("INT") || type.contains("DECIMAL") || type.contains("NUMERIC")
                    || type.contains("DOUBLE") || type.contains("FLOAT") || type.contains("REAL")) {
                return new BigDecimal(since);
            }
            return since;
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("since 与水位列类型（" + type + "）不匹配: " + since);
        }
    }

    private static Object display(ResultSet rs, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null || value instanceof Number || value instanceof Boolean) {
            return value;
        }
        if (value instanceof byte[] bytes) {
            return "<binary " + bytes.length + " bytes>";
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toLocalDateTime().toString().replace('T', ' ');
        }
        if (value instanceof java.sql.Date date) {
            return date.toString();
        }
        if (value instanceof Time time) {
            return time.toString();
        }
        return String.valueOf(value);
    }

    private static String text(Map<String, Object> body, String key) {
        Object value = body.get(key);
        return value == null ? "" : String.valueOf(value).trim();
    }
}
