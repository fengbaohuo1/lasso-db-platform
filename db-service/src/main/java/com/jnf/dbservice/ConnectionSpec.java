package com.jnf.dbservice;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 连接字段解析、校验与 JDBC URL 组装。
 * <p>支持三类连接：
 * <ul>
 *   <li>{@code mysql}：按 host/port/database 拼 MySQL URL（默认 3306，关闭 SSL 便于本地/内网接入）；</li>
 *   <li>{@code custom}：完全自定义 JDBC URL（H2/PostgreSQL 等，驱动需随插件提供）；</li>
 *   <li>{@code h2-demo}：内置 H2 演示库（只读展示，不可新增/覆盖）。</li>
 * </ul>
 * 可选 {@code jdbcUrl} 作为高级覆盖：mysql 类型下覆盖按字段拼出的 URL，custom 类型下必填。
 */
final class ConnectionSpec {

    static final String TYPE_MYSQL = "mysql";
    static final String TYPE_CUSTOM = "custom";
    static final String TYPE_H2_DEMO = "h2-demo";
    static final int MYSQL_DEFAULT_PORT = 3306;

    /** MySQL 连接参数：本地/内网可用优先，5s 连接超时避免界面长时间无响应。 */
    private static final String MYSQL_PARAMS =
            "?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai"
                    + "&characterEncoding=UTF-8&connectTimeout=5000";

    private static final Pattern MYSQL_URL = Pattern.compile(
            "^jdbc:mysql://([^/:?;]+)(?::(\\d+))?/([^?;]+)");

    private ConnectionSpec() {
    }

    /** 解析后的结构化连接（jdbcUrl 为最终生效 URL；h2-demo 由调用方换成内置演示连接）。 */
    record Spec(String type, String host, int port, String database, String jdbcUrl, String user, String password) {

        boolean isDemo() {
            return TYPE_H2_DEMO.equals(type);
        }

        DataSourceRegistry.DbConnection asTestConnection() {
            return new DataSourceRegistry.DbConnection("__test", "连接测试", "test",
                    type, host, port, database, jdbcUrl, user, password);
        }

        /** 名称留空时的默认名：MySQL 用 host/database，其它用 URL 末段。 */
        String defaultName() {
            if (TYPE_MYSQL.equals(type) && database != null && !database.isBlank()) {
                return host + "/" + database;
            }
            return defaultNameFromUrl(jdbcUrl);
        }
    }

    /** 规范化类型：空 → custom（兼容旧数据）；未知返回空串由调用方报错。 */
    static String normalizeType(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        return switch (value) {
            case TYPE_MYSQL -> TYPE_MYSQL;
            case TYPE_CUSTOM, "" -> TYPE_CUSTOM;
            case TYPE_H2_DEMO, "demo", "h2" -> TYPE_H2_DEMO;
            default -> "";
        };
    }

    /** 旧数据兜底：根据 URL 推断类型。 */
    static String typeOfJdbcUrl(String jdbcUrl) {
        return jdbcUrl != null && jdbcUrl.startsWith("jdbc:mysql:") ? TYPE_MYSQL : TYPE_CUSTOM;
    }

    /** 由字段拼 MySQL JDBC URL（固定参数串见上）。 */
    static String mysqlJdbcUrl(String host, int port, String database) {
        return "jdbc:mysql://" + host + ":" + port + "/" + database + MYSQL_PARAMS;
    }

    /**
     * 解析并校验结构化连接字段。
     * <p>mysql 要求 host/port/database/user；custom 要求 jdbcUrl；h2-demo 不需要字段。
     */
    static Spec parse(Map<String, Object> input) {
        String type = normalizeType(text(input, "type"));
        if (type.isEmpty()) {
            throw new IllegalArgumentException("连接类型不合法，可选：mysql / h2-demo / custom");
        }
        String host = text(input, "host");
        String database = text(input, "database");
        String user = text(input, "user");
        String rawPassword = input.get("password") == null ? "" : String.valueOf(input.get("password"));
        String override = text(input, "jdbcUrl");
        int port = 0;

        if (TYPE_MYSQL.equals(type)) {
            if (host.isEmpty()) {
                throw new IllegalArgumentException("MySQL 连接需要填写主机（host）");
            }
            port = parsePort(text(input, "port"), MYSQL_DEFAULT_PORT);
            if (database.isEmpty()) {
                throw new IllegalArgumentException("MySQL 连接需要填写数据库名（database）");
            }
            if (user.isEmpty()) {
                throw new IllegalArgumentException("MySQL 连接需要填写用户名（user）");
            }
        }
        if (TYPE_CUSTOM.equals(type)) {
            if (override.isEmpty()) {
                throw new IllegalArgumentException("自定义连接需要填写 JDBC URL（jdbcUrl）");
            }
        }
        if (!override.isEmpty()) {
            requireJdbc(override);
        }

        String jdbcUrl;
        if (TYPE_H2_DEMO.equals(type)) {
            jdbcUrl = "";
        } else if (TYPE_MYSQL.equals(type)) {
            jdbcUrl = override.isEmpty() ? mysqlJdbcUrl(host, port, database) : override;
        } else {
            jdbcUrl = override;
        }
        return new Spec(type, host, port, database, jdbcUrl, user,
                rawPassword.isBlank() ? null : rawPassword);
    }

    /** 从 MySQL URL 反解 host/port/database（旧 connections.json 迁移用；解析失败返回 null）。 */
    static String[] parseMysqlUrl(String jdbcUrl) {
        if (jdbcUrl == null) {
            return null;
        }
        Matcher matcher = MYSQL_URL.matcher(jdbcUrl);
        if (!matcher.find()) {
            return null;
        }
        String port = matcher.group(2) == null ? String.valueOf(MYSQL_DEFAULT_PORT) : matcher.group(2);
        return new String[]{matcher.group(1), port, matcher.group(3)};
    }

    /** 类型中文标签（REST 响应与前端提示共用）。 */
    static String label(String type) {
        if (TYPE_MYSQL.equals(type)) {
            return "MySQL";
        }
        if (TYPE_H2_DEMO.equals(type)) {
            return "内置演示库（H2）";
        }
        return "自定义 JDBC";
    }

    static int parsePort(String raw, int defaultPort) {
        if (raw == null || raw.isBlank()) {
            return defaultPort;
        }
        try {
            int port = Integer.parseInt(raw.trim());
            if (port < 1 || port > 65535) {
                throw new NumberFormatException("out of range");
            }
            return port;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("端口必须是 1-65535 的数字: " + raw);
        }
    }

    private static void requireJdbc(String jdbcUrl) {
        if (!jdbcUrl.startsWith("jdbc:")) {
            throw new IllegalArgumentException("jdbcUrl 必须以 jdbc: 开头，例如 jdbc:mysql://host:3306/db");
        }
    }

    private static String text(Map<String, Object> input, String key) {
        Object value = input.get(key);
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static String defaultNameFromUrl(String jdbcUrl) {
        if (jdbcUrl == null || jdbcUrl.isBlank()) {
            return "自定义连接";
        }
        String raw = jdbcUrl.substring("jdbc:".length());
        int cut = raw.indexOf(';');
        if (cut >= 0) {
            raw = raw.substring(0, cut);
        }
        raw = raw.replaceAll("[/:=?&]+", "-").replaceAll("^-+|-+$", "");
        return raw.isEmpty() ? "自定义连接" : raw;
    }
}


