package com.jnf.dbservice;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** 元数据浏览、DDL、EXPLAIN、只读查询执行、Markdown 预览等共用逻辑（H2 / MySQL 双方言）。 */
final class DbSupport {

    private DbSupport() {
    }

    /* ------------------------------ 方言与标识符 ------------------------------ */

    static boolean isMysql(Connection connection) throws SQLException {
        return product(connection).contains("mysql");
    }

    static boolean isH2(Connection connection) throws SQLException {
        return product(connection).contains("h2");
    }

    private static String product(Connection connection) throws SQLException {
        String name = connection.getMetaData().getDatabaseProductName();
        return name == null ? "" : name.toLowerCase(Locale.ROOT);
    }

    /** 方言名（MySQL / H2 / JDBC），用于响应与调试。 */
    static String dialect(Connection connection) throws SQLException {
        if (isMysql(connection)) {
            return "mysql";
        }
        if (isH2(connection)) {
            return "h2";
        }
        return "jdbc";
    }

    /** 按驱动上报的标识符引用符加引号；MySQL 为反引号、H2 为双引号，均转义内部引号。 */
    static String quote(Connection connection, String identifier) throws SQLException {
        String quote = connection.getMetaData().getIdentifierQuoteString();
        if (quote == null || quote.isBlank() || " ".equals(quote)) {
            quote = "\"";
        }
        return quote + identifier.replace(quote, quote + quote) + quote;
    }

    /** schema.table 限定名（schema 为空时只用表名）。 */
    static String qualify(Connection connection, String schema, String table) throws SQLException {
        if (schema == null || schema.isBlank()) {
            return quote(connection, table);
        }
        return quote(connection, schema) + "." + quote(connection, table);
    }

    /** 切换 schema 上下文：MySQL 用 catalog（database），H2 用 schema。 */
    static void applySchema(Connection connection, String schema) throws SQLException {
        if (schema == null || schema.isBlank()) {
            return;
        }
        if (isMysql(connection)) {
            if (!schema.equalsIgnoreCase(connection.getCatalog())) {
                connection.setCatalog(schema);
            }
        } else if (!schema.equalsIgnoreCase(connection.getSchema())) {
            connection.setSchema(schema);
        }
    }

    /* ------------------------------ 命名空间（库 / schema） ------------------------------ */

    /** 列出可用命名空间：MySQL 为 database（SHOW DATABASES），H2 为 schema（JDBC/JDBC 兜底 INFORMATION_SCHEMA）。 */
    static Map<String, Object> namespaces(Connection connection) throws SQLException {
        List<Map<String, Object>> items = new ArrayList<>();
        if (isMysql(connection)) {
            try (Statement statement = connection.createStatement();
                 ResultSet rs = statement.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    String name = rs.getString(1);
                    items.add(namespaceItem(name, "database", isSystemDatabase(name)));
                }
            }
        } else {
            try (ResultSet rs = connection.getMetaData().getSchemas()) {
                while (rs.next()) {
                    String name = rs.getString("TABLE_SCHEM");
                    items.add(namespaceItem(name, "schema", isSystemSchema(name)));
                }
            }
            if (items.isEmpty()) {
                try (Statement statement = connection.createStatement();
                     ResultSet rs = statement.executeQuery("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA")) {
                    while (rs.next()) {
                        String name = rs.getString(1);
                        items.add(namespaceItem(name, "schema", isSystemSchema(name)));
                    }
                }
            }
        }
        items.sort(Comparator
                .comparing((Map<String, Object> item) -> Boolean.TRUE.equals(item.get("isSystem")))
                .thenComparing(item -> String.valueOf(item.get("name")).toLowerCase(Locale.ROOT)));
        String defaultName = isMysql(connection) ? connection.getCatalog() : connection.getSchema();
        String canonicalDefault = "";
        for (Map<String, Object> item : items) {
            String name = String.valueOf(item.get("name"));
            if (defaultName != null && name.equalsIgnoreCase(defaultName)) {
                canonicalDefault = name;
                break;
            }
        }
        if (canonicalDefault.isEmpty()) {
            canonicalDefault = items.stream()
                    .filter(item -> !Boolean.TRUE.equals(item.get("isSystem")))
                    .map(item -> String.valueOf(item.get("name")))
                    .findFirst().orElse("");
        }
        for (Map<String, Object> item : items) {
            item.put("current", canonicalDefault.equalsIgnoreCase(String.valueOf(item.get("name"))));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", items);
        result.put("default", canonicalDefault);
        result.put("dialect", dialect(connection));
        return result;
    }

    private static Map<String, Object> namespaceItem(String name, String type, boolean system) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", name);
        item.put("type", type);
        item.put("isSystem", system);
        return item;
    }

    /** 校验 schema/库名（防止把任意字符串拼进 SQL）：必须命中实际命名空间，返回其规范大小写。 */
    static String resolveSchema(Connection connection, String rawSchema) throws SQLException {
        if (rawSchema == null || rawSchema.isBlank()) {
            return null;
        }
        String requested = rawSchema.trim();
        Object items = namespaces(connection).get("items");
        if (items instanceof List<?> list) {
            for (Object element : list) {
                if (element instanceof Map<?, ?> item && item.get("name") != null
                        && String.valueOf(item.get("name")).equalsIgnoreCase(requested)) {
                    return String.valueOf(item.get("name"));
                }
            }
        }
        throw new IllegalArgumentException("schema/库不存在: " + requested);
    }

    /* ------------------------------ 元数据 ------------------------------ */

    static List<Map<String, Object>> tables(Connection connection) throws SQLException {
        return tables(connection, null);
    }

    /** 表/视图清单；schema 为空时按连接默认上下文。行数统计失败降级为 -1。 */
    static List<Map<String, Object>> tables(Connection connection, String rawSchema) throws SQLException {
        String schema = resolveSchema(connection, rawSchema);
        if (schema != null) {
            applySchema(connection, schema);
        }
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        List<Map<String, Object>> tables = new ArrayList<>();
        try (ResultSet rs = connection.getMetaData()
                .getTables(catalog, schemaPattern, "%", new String[]{"TABLE", "VIEW"})) {
            while (rs.next()) {
                String tableSchema = rs.getString("TABLE_SCHEM");
                if (isMysql(connection)) {
                    tableSchema = rs.getString("TABLE_CAT");
                }
                if (schemaPattern == null && isSystemSchema(tableSchema)) {
                    continue;
                }
                String name = rs.getString("TABLE_NAME");
                String type = rs.getString("TABLE_TYPE");
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", name);
                item.put("schema", tableSchema);
                item.put("type", "VIEW".equalsIgnoreCase(type) ? "VIEW" : "TABLE");
                item.put("rows", countRows(connection, tableSchema, name));
                tables.add(item);
            }
        }
        tables.sort((a, b) -> Long.compare(asLong(b.get("rows")), asLong(a.get("rows"))));
        return tables;
    }

    static Map<String, Object> describe(Connection connection, String rawTable) throws SQLException {
        String table = resolveTable(connection, null, rawTable);
        return tableDetail(connection, null, table);
    }

    static String resolveTable(Connection connection, String rawTable) throws SQLException {
        return resolveTable(connection, null, rawTable);
    }

    static String resolveTable(Connection connection, String rawSchema, String rawTable) throws SQLException {
        if (rawTable == null || rawTable.isBlank()) {
            throw new IllegalArgumentException("table 不能为空");
        }
        String requested = rawTable.trim();
        for (Map<String, Object> table : tables(connection, rawSchema)) {
            if (String.valueOf(table.get("name")).equalsIgnoreCase(requested)) {
                return String.valueOf(table.get("name"));
            }
        }
        throw new IllegalArgumentException("表不存在: " + requested + (rawSchema == null ? "" : "（schema=" + rawSchema + "）"));
    }

    /** 表类型：TABLE / VIEW（解析不到时按 TABLE）。 */
    static String tableKind(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        try (ResultSet rs = connection.getMetaData().getTables(catalog, schemaPattern, table, new String[]{"TABLE", "VIEW"})) {
            if (rs.next()) {
                return "VIEW".equalsIgnoreCase(rs.getString("TABLE_TYPE")) ? "VIEW" : "TABLE";
            }
        }
        return "TABLE";
    }

    /** 注释解码结果：text 为展示文本，decoded 表示是否经过双重编码修复。 */
    record CommentText(String text, boolean decoded) {
    }

    static String tableComment(Connection connection, String schema, String table) {
        return tableCommentInfo(connection, schema, table).text();
    }

    /** 表注释（MySQL 历史双重编码做显示层修复；H2 原样）。 */
    static CommentText tableCommentInfo(Connection connection, String schema, String table) {
        try {
            String catalog = isMysql(connection) ? schema : null;
            String schemaPattern = isMysql(connection) ? null : schema;
            try (ResultSet rs = connection.getMetaData().getTables(catalog, schemaPattern, table, null)) {
                if (rs.next()) {
                    return decodeComment(connection, rs.getString("REMARKS"));
                }
            }
        } catch (SQLException ignored) {
            // 注释取不到不影响主流程
        }
        return new CommentText("", false);
    }

    private static CommentText decodeComment(Connection connection, String raw) {
        String text = blankToEmpty(raw);
        if (text.isEmpty()) {
            return new CommentText("", false);
        }
        try {
            String decoded = decodeLegacyComment(isMysql(connection), text);
            return decoded.equals(text) ? new CommentText(text, false) : new CommentText(decoded, true);
        } catch (SQLException ignored) {
            return new CommentText(text, false);
        }
    }

    /**
     * 显示层修复历史“双重编码”注释：UTF-8 字节曾被按 GBK 误解码后写入 utf8mb4，读出来即乱码。
     * <p>仅当原文可 GBK 编码、且结果能被严格 UTF-8 解码并含 CJK 时采用；非 MySQL 一律不解码；
     * 已含替换字符（损坏、不可恢复）的注释保持原样。
     */
    static String decodeLegacyComment(boolean mysql, String raw) {
        if (!mysql || raw == null || raw.isEmpty() || raw.indexOf('\uFFFD') >= 0) {
            return raw;
        }
        Charset gbk = Charset.forName("GBK");
        CharsetEncoder encoder = gbk.newEncoder();
        if (!encoder.canEncode(raw)) {
            return raw;
        }
        String candidate;
        try {
            candidate = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw.getBytes(gbk)))
                    .toString();
        } catch (CharacterCodingException invalid) {
            return raw; // GBK 字节不是合法 UTF-8 → 原文本来就是正常文本
        }
        if (candidate.isEmpty() || candidate.equals(raw) || !containsCjk(candidate)) {
            return raw;
        }
        return candidate;
    }

    private static boolean containsCjk(String text) {
        for (int i = 0; i < text.length(); ) {
            int codePoint = text.codePointAt(i);
            Character.UnicodeScript script = Character.UnicodeScript.of(codePoint);
            if (script == Character.UnicodeScript.HAN
                    || script == Character.UnicodeScript.HIRAGANA
                    || script == Character.UnicodeScript.KATAKANA
                    || script == Character.UnicodeScript.HANGUL) {
                return true;
            }
            i += Character.charCount(codePoint);
        }
        return false;
    }

    /** 列元数据：名称/类型/长度/小数位/可空/默认值/自增/注释/主键/序号。 */
    static List<Map<String, Object>> columnMeta(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        List<String> primaryKeys = primaryKeys(connection, schema, table);
        List<Map<String, Object>> columns = new ArrayList<>();
        try (ResultSet rs = connection.getMetaData().getColumns(catalog, schemaPattern, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                Map<String, Object> column = new LinkedHashMap<>();
                column.put("name", name);
                column.put("type", rs.getString("TYPE_NAME"));
                column.put("length", rs.getInt("COLUMN_SIZE"));
                column.put("decimals", rs.getInt("DECIMAL_DIGITS"));
                column.put("nullable", "YES".equalsIgnoreCase(rs.getString("IS_NULLABLE")));
                column.put("defaultValue", rs.getString("COLUMN_DEF"));
                column.put("autoIncrement", "YES".equalsIgnoreCase(rs.getString("IS_AUTOINCREMENT")));
                CommentText comment = decodeComment(connection, rs.getString("REMARKS"));
                column.put("comment", comment.text());
                column.put("commentDecoded", comment.decoded());
                column.put("primaryKey", primaryKeys.stream().anyMatch(pk -> pk.equalsIgnoreCase(name)));
                column.put("position", rs.getInt("ORDINAL_POSITION"));
                column.put("ordinal", rs.getInt("ORDINAL_POSITION"));
                columns.add(column);
            }
        }
        columns.sort(Comparator.comparingInt(column -> asInt(column.get("position"))));
        return columns;
    }

    static List<String> primaryKeys(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        Map<Integer, String> ordered = new java.util.TreeMap<>();
        try (ResultSet rs = connection.getMetaData().getPrimaryKeys(catalog, schemaPattern, table)) {
            while (rs.next()) {
                ordered.put(rs.getInt("KEY_SEQ"), rs.getString("COLUMN_NAME"));
            }
        }
        return new ArrayList<>(ordered.values());
    }

    /** 外键（导入键）清单：名称 / 本表列 / 引用库表列 / 更新删除策略。 */
    static List<Map<String, Object>> foreignKeys(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        Map<String, Map<String, Object>> grouped = new LinkedHashMap<>();
        try (ResultSet rs = connection.getMetaData().getImportedKeys(catalog, schemaPattern, table)) {
            while (rs.next()) {
                String name = blankToEmpty(rs.getString("FK_NAME"));
                String key = name.isEmpty() ? "fk-" + rs.getInt("KEY_SEQ") : name;
                Map<String, Object> fk = grouped.computeIfAbsent(key, ignored -> {
                    Map<String, Object> created = new LinkedHashMap<>();
                    created.put("name", name);
                    created.put("columns", new ArrayList<String>());
                    created.put("refSchema", "");
                    created.put("refTable", "");
                    created.put("refColumns", new ArrayList<String>());
                    created.put("onUpdate", rule(0));
                    created.put("onDelete", rule(0));
                    return created;
                });
                @SuppressWarnings("unchecked")
                List<String> columns = (List<String>) fk.get("columns");
                @SuppressWarnings("unchecked")
                List<String> refColumns = (List<String>) fk.get("refColumns");
                columns.add(rs.getString("FKCOLUMN_NAME"));
                refColumns.add(rs.getString("PKCOLUMN_NAME"));
                fk.put("refSchema", blankToEmpty(rs.getString("PKTABLE_SCHEM")));
                fk.put("refTable", blankToEmpty(rs.getString("PKTABLE_NAME")));
                fk.put("onUpdate", rule(rs.getInt("UPDATE_RULE")));
                fk.put("onDelete", rule(rs.getInt("DELETE_RULE")));
            }
        }
        return new ArrayList<>(grouped.values());
    }

    /** 外键单列视图：前端契约要求每个外键带 `column`/`refColumn`（多列外键取首列，完整列见 columns/refColumns）。 */
    private static List<Map<String, Object>> foreignKeyViews(List<Map<String, Object>> grouped) {
        for (Map<String, Object> fk : grouped) {
            @SuppressWarnings("unchecked")
            List<String> columns = (List<String>) fk.get("columns");
            @SuppressWarnings("unchecked")
            List<String> refColumns = (List<String>) fk.get("refColumns");
            fk.put("column", columns.isEmpty() ? "" : columns.get(0));
            fk.put("refColumn", refColumns.isEmpty() ? "" : refColumns.get(0));
        }
        return grouped;
    }

    private static String rule(int code) {
        return switch (code) {
            case DatabaseMetaData.importedKeyCascade -> "CASCADE";
            case DatabaseMetaData.importedKeySetNull -> "SET NULL";
            case DatabaseMetaData.importedKeySetDefault -> "SET DEFAULT";
            case DatabaseMetaData.importedKeyRestrict -> "RESTRICT";
            case DatabaseMetaData.importedKeyNoAction -> "NO ACTION";
            default -> "";
        };
    }

    /** 索引清单：名称 / 是否唯一 / 列（按序号）/ 是否主键索引。 */
    static List<Map<String, Object>> indexes(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        List<String> primaryKeys = primaryKeys(connection, schema, table);
        Map<String, Map<String, Object>> grouped = new LinkedHashMap<>();
        try (ResultSet rs = connection.getMetaData().getIndexInfo(catalog, schemaPattern, table, false, true)) {
            while (rs.next()) {
                String indexName = rs.getString("INDEX_NAME");
                String columnName = rs.getString("COLUMN_NAME");
                if (indexName == null || columnName == null) {
                    continue;
                }
                Map<String, Object> index = grouped.computeIfAbsent(indexName, ignored -> {
                    Map<String, Object> created = new LinkedHashMap<>();
                    created.put("name", indexName);
                    created.put("unique", false);
                    created.put("columns", new ArrayList<String>());
                    created.put("primary", false);
                    return created;
                });
                index.put("unique", !rs.getBoolean("NON_UNIQUE"));
                @SuppressWarnings("unchecked")
                List<String> indexColumns = (List<String>) index.get("columns");
                indexColumns.add(columnName);
            }
        }
        List<Map<String, Object>> result = new ArrayList<>(grouped.values());
        for (Map<String, Object> index : result) {
            @SuppressWarnings("unchecked")
            List<String> columns = (List<String>) index.get("columns");
            boolean primary = "PRIMARY".equalsIgnoreCase(String.valueOf(index.get("name")))
                    || (!primaryKeys.isEmpty() && columns.size() == primaryKeys.size()
                    && columns.stream().allMatch(column -> primaryKeys.stream().anyMatch(pk -> pk.equalsIgnoreCase(column))));
            index.put("primary", primary);
        }
        return result;
    }

    /** 行数（支持 schema 与过滤条件；失败返回 -1）。 */
    static int countRows(Connection connection, String table) {
        return countRows(connection, null, table, null);
    }

    static int countRows(Connection connection, String schema, String table) {
        return countRows(connection, schema, table, null);
    }

    static int countRows(Connection connection, String schema, String table, String whereClause) {
        try {
            String sql = "SELECT COUNT(*) FROM " + qualify(connection, schema, table)
                    + (whereClause == null ? "" : " WHERE " + whereClause);
            try (Statement statement = connection.createStatement();
                 ResultSet rs = statement.executeQuery(sql)) {
                return rs.next() ? rs.getInt(1) : -1;
            }
        } catch (SQLException e) {
            return -1;
        }
    }

    /* ------------------------------ 表详情 / DDL ------------------------------ */

    /** DataGrip 级表详情：列 / 主键 / 外键 / 索引 / 注释 / 行数 / 类型 / DDL。 */
    static Map<String, Object> tableDetail(Connection connection, String rawSchema, String rawTable) throws SQLException {
        String schema = resolveSchema(connection, rawSchema);
        if (schema != null) {
            applySchema(connection, schema);
        }
        String table = resolveTable(connection, schema, rawTable);
        String kind = tableKind(connection, schema, table);
        List<Map<String, Object>> columns = columnMeta(connection, schema, table);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", schema == null ? "" : schema);
        result.put("table", table);
        result.put("kind", kind);
        result.put("columns", columns);
        result.put("primaryKey", primaryKeys(connection, schema, table));
        result.put("foreignKeys", foreignKeyViews(foreignKeys(connection, schema, table)));
        result.put("indexes", indexes(connection, schema, table));
        result.put("rowCount", countRows(connection, schema, table));
        CommentText tableComment = tableCommentInfo(connection, schema, table);
        result.put("comment", tableComment.text());
        result.put("commentDecoded", tableComment.decoded());
        result.put("ddl", ddlText(connection, schema, table, kind));
        result.put("dialect", dialect(connection));
        return result;
    }

    /** 返回 DDL 文本：MySQL 用 SHOW CREATE TABLE/VIEW，H2 从 INFORMATION_SCHEMA/元数据拼。 */
    static Map<String, Object> ddl(Connection connection, String rawSchema, String rawTable) throws SQLException {
        String schema = resolveSchema(connection, rawSchema);
        if (schema != null) {
            applySchema(connection, schema);
        }
        String table = resolveTable(connection, schema, rawTable);
        String kind = tableKind(connection, schema, table);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", schema == null ? "" : schema);
        result.put("table", table);
        result.put("kind", kind);
        result.put("ddl", ddlText(connection, schema, table, kind));
        result.put("dialect", dialect(connection));
        return result;
    }

    private static String ddlText(Connection connection, String schema, String table, String kind) throws SQLException {
        if (isMysql(connection)) {
            return mysqlShowCreate(connection, schema, table, kind);
        }
        if (isH2(connection)) {
            return h2Ddl(connection, schema, table, kind);
        }
        return "-- 当前数据库（" + connection.getMetaData().getDatabaseProductName() + "）暂不支持 DDL 生成";
    }

    private static String mysqlShowCreate(Connection connection, String schema, String table, String kind) throws SQLException {
        String statement = "SHOW CREATE " + ("VIEW".equals(kind) ? "VIEW" : "TABLE") + " "
                + qualify(connection, schema, table);
        try (Statement st = connection.createStatement(); ResultSet rs = st.executeQuery(statement)) {
            if (rs.next()) {
                String ddl = rs.getString(2);
                if (ddl != null && !ddl.isBlank()) {
                    return ddl;
                }
            }
        }
        return "-- MySQL 未返回 DDL（可能缺少 SHOW VIEW 权限）";
    }

    private static String h2Ddl(Connection connection, String schema, String table, String kind) throws SQLException {
        if ("VIEW".equals(kind)) {
            String definition = h2ViewDefinition(connection, schema, table);
            if (definition != null && !definition.isBlank()) {
                return "CREATE VIEW " + qualify(connection, schema, table) + " AS\n" + definition.trim();
            }
            return "-- H2 无法读取视图定义: " + table;
        }
        List<Map<String, Object>> columns = columnMeta(connection, schema, table);
        List<String> primaryKeys = primaryKeys(connection, schema, table);
        StringBuilder ddl = new StringBuilder("CREATE TABLE ").append(qualify(connection, schema, table)).append(" (");
        List<String> lines = new ArrayList<>();
        for (Map<String, Object> column : columns) {
            StringBuilder line = new StringBuilder("  ").append(quote(connection, String.valueOf(column.get("name"))))
                    .append(' ').append(columnType(column));
            if (!Boolean.TRUE.equals(column.get("nullable"))) {
                line.append(" NOT NULL");
            }
            String defaultValue = column.get("defaultValue") == null ? "" : String.valueOf(column.get("defaultValue")).trim();
            if (!defaultValue.isEmpty() && !"NULL".equalsIgnoreCase(defaultValue)) {
                line.append(" DEFAULT ").append(defaultValue);
            }
            if (Boolean.TRUE.equals(column.get("autoIncrement"))) {
                line.append(" GENERATED BY DEFAULT AS IDENTITY");
            }
            lines.add(line.toString());
        }
        if (!primaryKeys.isEmpty()) {
            List<String> quoted = new ArrayList<>();
            for (String pk : primaryKeys) {
                quoted.add(quote(connection, pk));
            }
            lines.add("  PRIMARY KEY (" + String.join(", ", quoted) + ")");
        }
        ddl.append('\n').append(String.join(",\n", lines)).append("\n)");
        return ddl.toString();
    }

    private static String columnType(Map<String, Object> column) {
        String type = String.valueOf(column.get("type"));
        String upper = type.toUpperCase(Locale.ROOT);
        int length = asInt(column.get("length"));
        int decimals = asInt(column.get("decimals"));
        if (length > 0 && (upper.contains("CHAR") || upper.contains("BINARY") || upper.contains("DECIMAL")
                || upper.contains("NUMERIC"))) {
            if (decimals > 0 && (upper.contains("DECIMAL") || upper.contains("NUMERIC"))) {
                return type + "(" + length + "," + decimals + ")";
            }
            return type + "(" + length + ")";
        }
        return type;
    }

    private static String h2ViewDefinition(Connection connection, String schema, String table) {
        String sql = "SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_NAME = ?";
        sql += schema == null || schema.isBlank() ? "" : " AND TABLE_SCHEMA = ?";
        try (java.sql.PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, table);
            if (schema != null && !schema.isBlank()) {
                statement.setString(2, schema);
            }
            try (ResultSet rs = statement.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        } catch (SQLException ignored) {
            // 视图定义不可得时返回 null
        }
        return null;
    }

    /* ------------------------------ 查询执行 ------------------------------ */

    /** 执行 SQL（已被上层判定为只读），最多取 maxRows 行。 */
    static Map<String, Object> query(Connection connection, String sql, int maxRows) throws SQLException {
        long started = System.currentTimeMillis();
        List<String> columns = new ArrayList<>();
        List<Map<String, Object>> rows = new ArrayList<>();
        boolean truncated = false;
        try (Statement statement = connection.createStatement()) {
            statement.setQueryTimeout(15);
            statement.setMaxRows(maxRows + 1);
            try (ResultSet rs = statement.executeQuery(sql)) {
                var meta = rs.getMetaData();
                int columnCount = meta.getColumnCount();
                for (int i = 1; i <= columnCount; i++) {
                    columns.add(meta.getColumnLabel(i));
                }
                while (rs.next()) {
                    if (rows.size() >= maxRows) {
                        truncated = true;
                        break;
                    }
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= columnCount; i++) {
                        row.put(columns.get(i - 1), jdbcValue(rs, i));
                    }
                    rows.add(row);
                }
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("columns", columns);
        result.put("rows", rows);
        result.put("rowCount", rows.size());
        result.put("truncated", truncated);
        result.put("elapsedMs", System.currentTimeMillis() - started);
        result.put("previewMarkdown", preview(columns, rows, truncated));
        return result;
    }

    static Map<String, Object> sample(Connection connection, String rawTable, int limit) throws SQLException {
        String table = resolveTable(connection, null, rawTable);
        Map<String, Object> result = query(connection, "SELECT * FROM " + quote(connection, table) + " LIMIT " + limit, limit);
        result.put("table", table);
        return result;
    }

    /**
     * 表格分页浏览：数据库无关的 {@code LIMIT/OFFSET}；排序列必须是真实列（防注入）；
     * 过滤条件禁分号与注释；返回名称数组（兼容）与带类型的列元数据、总数、截断标记。
     */
    static Map<String, Object> tableData(Connection connection, String rawTable, int limit, int offset,
                                         String orderBy, boolean desc) throws SQLException {
        return tableData(connection, null, rawTable, limit, offset, orderBy, desc, null);
    }

    /** limit=0（不分页）时的安全上限：最多返回 5 万行，避免一次性把大表读进内存。 */
    static final int TABLE_DATA_LIMITLESS_CAP = 50_000;

    static Map<String, Object> tableData(Connection connection, String rawSchema, String rawTable, int limit, int offset,
                                         String orderBy, boolean desc, String rawFilter) throws SQLException {
        String schema = resolveSchema(connection, rawSchema);
        if (schema != null) {
            applySchema(connection, schema);
        }
        String table = resolveTable(connection, schema, rawTable);
        String where = normalizeFilter(rawFilter);
        String order = null;
        if (orderBy != null && !orderBy.isBlank()) {
            String requested = orderBy.trim();
            Set<String> names = new LinkedHashSet<>(columnNames(connection, schema, table));
            order = names.stream()
                    .filter(name -> name.equalsIgnoreCase(requested))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("排序列不存在: " + requested));
        }
        boolean limitLess = limit <= 0;
        int effectiveLimit = limitLess ? TABLE_DATA_LIMITLESS_CAP : limit;
        int effectiveOffset = limitLess ? 0 : offset;
        StringBuilder sql = new StringBuilder("SELECT * FROM ").append(qualify(connection, schema, table));
        if (where != null) {
            sql.append(" WHERE ").append(where);
        }
        if (order != null) {
            sql.append(" ORDER BY ").append(quote(connection, order)).append(desc ? " DESC" : " ASC");
        }
        // 多取 1 行用于判断是否还有更多（limit=0 时也据此标记 truncated）
        sql.append(" LIMIT ").append(effectiveLimit + 1).append(" OFFSET ").append(effectiveOffset);
        Map<String, Object> result = query(connection, sql.toString(), effectiveLimit + 1);
        Object rawRows = result.get("rows");
        if (rawRows instanceof List<?> rows && rows.size() > effectiveLimit) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> trimmed = new ArrayList<>((List<Map<String, Object>>) rows.subList(0, effectiveLimit));
            result.put("rows", trimmed);
            result.put("rowCount", trimmed.size());
        }
        int total = countRows(connection, schema, table, where);
        int returned = result.get("rowCount") instanceof Number number ? number.intValue() : 0;
        // 列名保留在 columnNames（兼容旧消费方），columns 按前端契约返回 [{name,type}]，列类型明细见 columnMeta
        Object names = result.get("columns");
        List<Map<String, Object>> columnMeta = columnMeta(connection, schema, table);
        List<Map<String, Object>> typedColumns = new ArrayList<>();
        for (Map<String, Object> column : columnMeta) {
            Map<String, Object> typed = new LinkedHashMap<>();
            typed.put("name", column.get("name"));
            typed.put("type", column.get("type"));
            typedColumns.add(typed);
        }
        result.put("columnNames", names == null ? List.of() : names);
        result.put("columns", typedColumns);
        result.put("columnMeta", columnMeta);
        result.put("table", table);
        result.put("schema", schema == null ? "" : schema);
        result.put("total", total);
        result.put("limit", limit);
        result.put("offset", effectiveOffset);
        result.put("paged", !limitLess);
        if (limitLess) {
            result.put("rowCap", TABLE_DATA_LIMITLESS_CAP);
        }
        result.put("orderBy", order);
        result.put("desc", order != null && desc);
        result.put("filter", rawFilter == null || rawFilter.isBlank() ? "" : rawFilter.trim());
        boolean capped = limitLess && returned >= effectiveLimit && (total < 0 || total > returned);
        result.put("truncated", capped || (total >= 0 && effectiveOffset + returned < total));
        result.remove("previewMarkdown");
        return result;
    }

    /** 过滤条件校验：长度 ≤ 500，禁止分号与 SQL 注释（防止多语句/注释绕过）。 */
    static String normalizeFilter(String rawFilter) {
        if (rawFilter == null || rawFilter.isBlank()) {
            return null;
        }
        String filter = rawFilter.trim();
        if (filter.length() > 500) {
            throw new IllegalArgumentException("filter 过长（最多 500 字符）: " + filter.length());
        }
        if (filter.contains(";") || filter.contains("--") || filter.contains("/*")
                || filter.contains("*/") || filter.contains("#")) {
            throw new IllegalArgumentException("filter 不允许包含分号或 SQL 注释（-- /* */ #）");
        }
        return "(" + filter + ")";
    }

    /* ------------------------------ 行级编辑（写操作，参数化 SQL） ------------------------------ */

    /** 列信息（行级编辑参数绑定与列白名单校验用）。 */
    private record ColumnInfo(String name, int jdbcType, boolean autoIncrement, boolean nullable) {
    }

    private record PkWhere(List<ColumnInfo> columns, List<Object> values) {
    }

    private static List<ColumnInfo> columnInfos(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        List<ColumnInfo> infos = new ArrayList<>();
        try (ResultSet rs = connection.getMetaData().getColumns(catalog, schemaPattern, table, "%")) {
            while (rs.next()) {
                infos.add(new ColumnInfo(rs.getString("COLUMN_NAME"), rs.getInt("DATA_TYPE"),
                        "YES".equalsIgnoreCase(rs.getString("IS_AUTOINCREMENT")),
                        "YES".equalsIgnoreCase(rs.getString("IS_NULLABLE"))));
            }
        }
        return infos;
    }

    private static ColumnInfo findColumn(List<ColumnInfo> columns, String requested) {
        for (ColumnInfo column : columns) {
            if (column.name().equalsIgnoreCase(requested)) {
                return column;
            }
        }
        throw new IllegalArgumentException("列不存在: " + requested + "（表内可用列: "
                + String.join(", ", columns.stream().map(ColumnInfo::name).toList()) + "）");
    }

    /** 空串按 NULL 处理（便于前端清空单元格），其它 JSON 值原样绑定。 */
    private static Object cellValue(Object raw) {
        return raw instanceof String text && text.isEmpty() ? null : raw;
    }

    private static void bind(PreparedStatement statement, int index, Object value, int jdbcType) throws SQLException {
        if (value == null) {
            statement.setNull(index, jdbcType);
            return;
        }
        if (value instanceof String text) {
            try {
                if (jdbcType == Types.DATE) {
                    statement.setDate(index, java.sql.Date.valueOf(text));
                    return;
                }
                if (jdbcType == Types.TIMESTAMP || jdbcType == Types.TIMESTAMP_WITH_TIMEZONE) {
                    statement.setTimestamp(index, java.sql.Timestamp.valueOf(text.replace('T', ' ')));
                    return;
                }
                if (jdbcType == Types.TIME) {
                    statement.setTime(index, java.sql.Time.valueOf(text));
                    return;
                }
            } catch (IllegalArgumentException invalid) {
                throw new IllegalArgumentException("时间值格式不正确: " + text, invalid);
            }
        }
        statement.setObject(index, value);
    }

    private static void requireEditableTable(Connection connection, String schema, String table) throws SQLException {
        if ("VIEW".equalsIgnoreCase(tableKind(connection, schema, table))) {
            throw new IllegalArgumentException("视图不支持行级编辑: " + table);
        }
    }

    /** 主键条件：必须有主键、pk 键必须都是主键列、且覆盖全部主键列（避免误改多行）。 */
    private static PkWhere pkWhere(Connection connection, String schema, String table,
                                   Map<String, Object> rawPk, String action) throws SQLException {
        if (rawPk == null || rawPk.isEmpty()) {
            throw new IllegalArgumentException(action + " 需要 pk（主键列值）");
        }
        List<ColumnInfo> columns = columnInfos(connection, schema, table);
        List<String> primaryKeys = primaryKeys(connection, schema, table);
        if (primaryKeys.isEmpty()) {
            throw new IllegalArgumentException("表没有主键，已拒绝 " + action + "（无法唯一定位行）");
        }
        List<ColumnInfo> pkColumns = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (Map.Entry<String, Object> entry : rawPk.entrySet()) {
            ColumnInfo column = findColumn(columns, entry.getKey());
            boolean isPrimary = primaryKeys.stream().anyMatch(pk -> pk.equalsIgnoreCase(column.name()));
            if (!isPrimary) {
                throw new IllegalArgumentException("pk 列不是主键: " + column.name()
                        + "（主键: " + String.join(", ", primaryKeys) + "）");
            }
            pkColumns.add(column);
            values.add(cellValue(entry.getValue()));
        }
        if (pkColumns.size() != primaryKeys.size()) {
            throw new IllegalArgumentException("pk 必须包含全部主键列: " + String.join(", ", primaryKeys));
        }
        return new PkWhere(pkColumns, values);
    }

    /** 执行 UPDATE/INSERT/DELETE 前统一解析 schema/table 并拒绝视图。 */
    private static String[] resolveEditable(Connection connection, String rawSchema, String rawTable) throws SQLException {
        String schema = resolveSchema(connection, rawSchema);
        if (schema != null) {
            applySchema(connection, schema);
        }
        String table = resolveTable(connection, schema, rawTable);
        requireEditableTable(connection, schema, table);
        return new String[]{schema == null ? "" : schema, table};
    }

    /**
     * 行插入：列白名单来自真实列元数据，值全部走 PreparedStatement 参数绑定；
     * 返回 {@code {schema,table,affectedRows,generatedKeys}}。
     */
    static Map<String, Object> rowInsert(Connection connection, String rawSchema, String rawTable,
                                         Map<String, Object> rawValues) throws SQLException {
        String[] resolved = resolveEditable(connection, rawSchema, rawTable);
        String schema = resolved[0].isEmpty() ? null : resolved[0];
        String table = resolved[1];
        if (rawValues == null || rawValues.isEmpty()) {
            throw new IllegalArgumentException("values 不能为空");
        }
        List<ColumnInfo> columns = columnInfos(connection, schema, table);
        List<ColumnInfo> targets = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (Map.Entry<String, Object> entry : rawValues.entrySet()) {
            ColumnInfo column = findColumn(columns, entry.getKey());
            if (targets.stream().anyMatch(target -> target.name().equalsIgnoreCase(column.name()))) {
                throw new IllegalArgumentException("values 中列重复: " + column.name());
            }
            targets.add(column);
            values.add(cellValue(entry.getValue()));
        }
        StringBuilder sql = new StringBuilder("INSERT INTO ").append(qualify(connection, schema, table)).append(" (");
        for (int i = 0; i < targets.size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            sql.append(quote(connection, targets.get(i).name()));
        }
        sql.append(") VALUES (");
        for (int i = 0; i < targets.size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            sql.append('?');
        }
        sql.append(')');

        List<Object> generatedKeys = new ArrayList<>();
        int affectedRows;
        try (PreparedStatement statement = connection.prepareStatement(sql.toString(), Statement.RETURN_GENERATED_KEYS)) {
            for (int i = 0; i < targets.size(); i++) {
                bind(statement, i + 1, values.get(i), targets.get(i).jdbcType());
            }
            affectedRows = statement.executeUpdate();
            try (ResultSet keys = statement.getGeneratedKeys()) {
                while (keys.next()) {
                    generatedKeys.add(jdbcValue(keys, 1));
                }
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", resolved[0]);
        result.put("table", table);
        result.put("affectedRows", affectedRows);
        result.put("generatedKeys", generatedKeys);
        return result;
    }

    /** 行更新：按主键定位，仅允许修改非主键列；返回 {schema,table,affectedRows}。 */
    static Map<String, Object> rowUpdate(Connection connection, String rawSchema, String rawTable,
                                         Map<String, Object> rawPk, Map<String, Object> rawChanges) throws SQLException {
        String[] resolved = resolveEditable(connection, rawSchema, rawTable);
        String schema = resolved[0].isEmpty() ? null : resolved[0];
        String table = resolved[1];
        if (rawChanges == null || rawChanges.isEmpty()) {
            throw new IllegalArgumentException("changes 不能为空");
        }
        PkWhere where = pkWhere(connection, schema, table, rawPk, "row-update");
        List<ColumnInfo> columns = columnInfos(connection, schema, table);
        List<ColumnInfo> targets = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (Map.Entry<String, Object> entry : rawChanges.entrySet()) {
            ColumnInfo column = findColumn(columns, entry.getKey());
            boolean isPrimary = where.columns().stream().anyMatch(pk -> pk.name().equalsIgnoreCase(column.name()));
            if (isPrimary) {
                throw new IllegalArgumentException("不允许通过 row-update 修改主键列: " + column.name());
            }
            if (targets.stream().anyMatch(target -> target.name().equalsIgnoreCase(column.name()))) {
                throw new IllegalArgumentException("changes 中列重复: " + column.name());
            }
            targets.add(column);
            values.add(cellValue(entry.getValue()));
        }
        StringBuilder sql = new StringBuilder("UPDATE ").append(qualify(connection, schema, table)).append(" SET ");
        for (int i = 0; i < targets.size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            sql.append(quote(connection, targets.get(i).name())).append(" = ?");
        }
        sql.append(" WHERE ");
        for (int i = 0; i < where.columns().size(); i++) {
            if (i > 0) {
                sql.append(" AND ");
            }
            sql.append(quote(connection, where.columns().get(i).name())).append(" = ?");
        }
        int affectedRows;
        try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
            int index = 1;
            for (int i = 0; i < targets.size(); i++) {
                bind(statement, index++, values.get(i), targets.get(i).jdbcType());
            }
            for (int i = 0; i < where.columns().size(); i++) {
                bind(statement, index++, where.values().get(i), where.columns().get(i).jdbcType());
            }
            affectedRows = statement.executeUpdate();
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", resolved[0]);
        result.put("table", table);
        result.put("affectedRows", affectedRows);
        return result;
    }

    /** 行删除：按主键定位；返回 {schema,table,affectedRows}。 */
    static Map<String, Object> rowDelete(Connection connection, String rawSchema, String rawTable,
                                         Map<String, Object> rawPk) throws SQLException {
        String[] resolved = resolveEditable(connection, rawSchema, rawTable);
        String schema = resolved[0].isEmpty() ? null : resolved[0];
        String table = resolved[1];
        PkWhere where = pkWhere(connection, schema, table, rawPk, "row-delete");
        StringBuilder sql = new StringBuilder("DELETE FROM ").append(qualify(connection, schema, table)).append(" WHERE ");
        for (int i = 0; i < where.columns().size(); i++) {
            if (i > 0) {
                sql.append(" AND ");
            }
            sql.append(quote(connection, where.columns().get(i).name())).append(" = ?");
        }
        int affectedRows;
        try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
            for (int i = 0; i < where.columns().size(); i++) {
                bind(statement, i + 1, where.values().get(i), where.columns().get(i).jdbcType());
            }
            affectedRows = statement.executeUpdate();
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", resolved[0]);
        result.put("table", table);
        result.put("affectedRows", affectedRows);
        return result;
    }

    private static List<String> columnNames(Connection connection, String schema, String table) throws SQLException {
        String catalog = isMysql(connection) ? schema : null;
        String schemaPattern = isMysql(connection) ? null : schema;
        List<String> names = new ArrayList<>();
        try (ResultSet rs = connection.getMetaData().getColumns(catalog, schemaPattern, table, "%")) {
            while (rs.next()) {
                names.add(rs.getString("COLUMN_NAME"));
            }
        }
        return names;
    }

    private static Object jdbcValue(ResultSet rs, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null || value instanceof Number || value instanceof Boolean) {
            return value;
        }
        if (value instanceof byte[]) {
            return "<binary " + ((byte[]) value).length + " bytes>";
        }
        if (value instanceof java.sql.Timestamp timestamp) {
            return timestamp.toLocalDateTime().toString().replace('T', ' ');
        }
        if (value instanceof java.sql.Date date) {
            return date.toString();
        }
        if (value instanceof java.sql.Time time) {
            return time.toString();
        }
        return String.valueOf(value);
    }

    static String preview(List<String> columns, List<Map<String, Object>> rows, boolean truncated) {
        if (columns.isEmpty()) {
            return "（无结果列）";
        }
        List<String> shownColumns = columns.size() > 8 ? columns.subList(0, 8) : columns;
        StringBuilder sb = new StringBuilder();
        sb.append("| ").append(String.join(" | ", shownColumns)).append(" |\n");
        sb.append("|");
        for (int i = 0; i < shownColumns.size(); i++) {
            sb.append(" --- |");
        }
        sb.append('\n');
        int shownRows = Math.min(rows.size(), 20);
        for (int r = 0; r < shownRows; r++) {
            sb.append("| ");
            for (int c = 0; c < shownColumns.size(); c++) {
                if (c > 0) {
                    sb.append(" | ");
                }
                sb.append(cell(rows.get(r).get(shownColumns.get(c))));
            }
            sb.append(" |\n");
        }
        if (columns.size() > shownColumns.size()) {
            sb.append("\n_另有 ").append(columns.size() - shownColumns.size()).append(" 列未展示_");
        }
        if (rows.size() > shownRows) {
            sb.append("\n_另有 ").append(rows.size() - shownRows).append(" 行未展示_");
        }
        if (truncated) {
            sb.append("\n_结果已截断（受 maxRows 限制）_");
        }
        return sb.toString();
    }

    private static String cell(Object value) {
        if (value == null) {
            return "NULL";
        }
        return String.valueOf(value).replace("|", "\\|").replace("\n", " ");
    }

    /* ------------------------------ SQL 判定 ------------------------------ */

    private static final List<String> READ_ONLY_KEYWORDS = List.of("SELECT", "WITH", "EXPLAIN", "VALUES", "SHOW", "DESCRIBE");

    static boolean isReadOnly(String sql) {
        return READ_ONLY_KEYWORDS.contains(firstKeyword(sql));
    }

    /** 单条语句校验：允许结尾分号，拒绝中间分号（防多语句拼接）。 */
    static String singleStatement(String sql) {
        String trimmed = sql == null ? "" : sql.trim();
        if (trimmed.endsWith(";")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1).trim();
        }
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("sql 不能为空");
        }
        if (trimmed.contains(";")) {
            throw new IllegalArgumentException("只允许执行单条 SQL 语句");
        }
        return trimmed;
    }

    static String firstKeyword(String sql) {
        int i = 0;
        int n = sql == null ? 0 : sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                int newline = sql.indexOf('\n', i);
                if (newline < 0) {
                    return "";
                }
                i = newline + 1;
                continue;
            }
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2);
                if (end < 0) {
                    return "";
                }
                i = end + 2;
                continue;
            }
            break;
        }
        int start = i;
        while (i < n && Character.isLetter(sql.charAt(i))) {
            i++;
        }
        return sql.substring(start, i).toUpperCase(Locale.ROOT);
    }

    static String quote(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    /** 注释中的表/列名去 NULL；返回空串便于 JSON 稳定。 */
    static String blankToEmpty(String value) {
        return value == null ? "" : value;
    }

    /** 系统 schema 判定：INFORMATION_SCHEMA / PG_* / SYS（H2、MySQL、PostgreSQL 通用）。 */
    static boolean isSystemSchema(String schema) {
        if (schema == null) {
            return false;
        }
        String upper = schema.toUpperCase(Locale.ROOT);
        return upper.startsWith("INFORMATION_SCHEMA") || upper.startsWith("PG_")
                || "SYS".equals(upper) || "MYSQL".equals(upper) || "PERFORMANCE_SCHEMA".equals(upper);
    }

    /** MySQL 系统库判定（系统标记用于前端灰显，仍可手动指定查询）。 */
    static boolean isSystemDatabase(String name) {
        if (name == null) {
            return false;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        return "information_schema".equals(lower) || "mysql".equals(lower)
                || "performance_schema".equals(lower) || "sys".equals(lower);
    }

    private static long asLong(Object value) {
        return value instanceof Number number ? number.longValue() : -1L;
    }

    private static int asInt(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }
}

