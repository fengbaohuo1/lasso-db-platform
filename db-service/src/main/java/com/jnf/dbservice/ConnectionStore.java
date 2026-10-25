package com.jnf.dbservice;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 连接存储：{@code <dataDir>/connections.json}。
 * <p>持久化结构化字段（type/host/port/database/user/jdbcUrl），
 * 只在 {@code savePassword=true} 时写入密码字段；文件权限依赖操作系统，README 明示明文风险。
 */
final class ConnectionStore {

    /** 连接数量上限（含 demo 之外的存储连接）。 */
    static final int MAX_CONNECTIONS = 20;
    /** JSON 结构版本：2 = 结构化字段（旧版本仅 id/name/jdbcUrl/user/password，加载时自动兼容）。 */
    private static final int FORMAT_VERSION = 2;

    /**
     * 存储连接：password 为 null 表示“未保存密码”；type 为 mysql / custom；
     * port 对 custom 可能为 0，host/database 对 custom 可能为空。
     */
    record StoredConnection(String id, String name, String type, String host, int port, String database,
                            String jdbcUrl, String user, String password) {

        StoredConnection withoutPassword() {
            return new StoredConnection(id, name, type, host, port, database, jdbcUrl, user, null);
        }
    }

    private final Path dir;

    ConnectionStore(Path dir) {
        this.dir = dir;
    }

    Path file() {
        return dir.resolve("connections.json");
    }

    /** 读取全部存储连接；文件不存在或损坏时返回空列表（损坏文件会改名备份）。 */
    List<StoredConnection> load() {
        Path file = file();
        if (!Files.isRegularFile(file)) {
            return List.of();
        }
        String raw;
        try {
            raw = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("读取连接配置失败: " + e.getMessage(), e);
        }
        try {
            Object parsed = Json.parse(raw);
            List<StoredConnection> connections = new ArrayList<>();
            Object items = parsed instanceof Map<?, ?> map ? map.get("connections") : null;
            if (items instanceof List<?> list) {
                for (Object element : list) {
                    if (!(element instanceof Map<?, ?> item)) {
                        continue;
                    }
                    String id = text(item.get("id"));
                    String jdbcUrl = text(item.get("jdbcUrl"));
                    if (id.isBlank() || jdbcUrl.isBlank()) {
                        continue;
                    }
                    String type = ConnectionSpec.normalizeType(text(item.get("type")));
                    if (type.isEmpty() || ConnectionSpec.TYPE_H2_DEMO.equals(type)) {
                        type = ConnectionSpec.typeOfJdbcUrl(jdbcUrl);
                    }
                    String host = text(item.get("host"));
                    String database = text(item.get("database"));
                    int port = intValue(item.get("port"));
                    if (ConnectionSpec.TYPE_MYSQL.equals(type) && (host.isEmpty() || port <= 0 || database.isEmpty())) {
                        // 旧格式（只存 jdbcUrl）迁移：从 MySQL URL 反解结构化字段
                        String[] parsedMysql = ConnectionSpec.parseMysqlUrl(jdbcUrl);
                        if (parsedMysql != null) {
                            if (host.isEmpty()) {
                                host = parsedMysql[0];
                            }
                            if (port <= 0) {
                                port = ConnectionSpec.parsePort(parsedMysql[1], ConnectionSpec.MYSQL_DEFAULT_PORT);
                            }
                            if (database.isEmpty()) {
                                database = parsedMysql[2];
                            }
                        }
                    }
                    connections.add(new StoredConnection(id, blankTo(id, text(item.get("name"))), type,
                            host, port, database, jdbcUrl,
                            nullableText(item.get("user")), nullableText(item.get("password"))));
                }
            }
            return connections;
        } catch (IllegalArgumentException e) {
            backupCorrupt(file);
            return List.of();
        }
    }

    /** 全量写回（先写临时文件再替换，避免半截文件）。 */
    void save(List<StoredConnection> connections) {
        List<Map<String, Object>> items = new ArrayList<>();
        for (StoredConnection connection : connections) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", connection.id());
            item.put("name", connection.name());
            item.put("type", connection.type());
            item.put("host", connection.host());
            item.put("port", connection.port());
            item.put("database", connection.database());
            item.put("jdbcUrl", connection.jdbcUrl());
            item.put("user", connection.user());
            if (connection.password() != null) {
                item.put("password", connection.password());
            }
            items.add(item);
        }
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("version", FORMAT_VERSION);
        root.put("connections", items);
        try {
            Files.createDirectories(dir);
            Path target = file();
            Path temp = dir.resolve("connections.json.tmp");
            Files.writeString(temp, Json.write(root), StandardCharsets.UTF_8);
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new IllegalStateException("保存连接配置失败: " + e.getMessage(), e);
        }
    }

    /* ------------------------------ 校验与命名 ------------------------------ */

    private static final java.util.regex.Pattern ID_PATTERN =
            java.util.regex.Pattern.compile("[a-z0-9][a-z0-9-]{0,47}");

    static boolean validId(String id) {
        return id != null && ID_PATTERN.matcher(id).matches() && !"demo".equals(id);
    }

    /** 由名称/URL 生成 kebab-case id；保证唯一（重名追加 -2、-3…）。 */
    static String suggestId(String source, List<StoredConnection> existing) {
        String base = slug(source);
        List<String> ids = existing.stream().map(StoredConnection::id).toList();
        String candidate = base;
        int suffix = 2;
        while (ids.contains(candidate)) {
            candidate = base + "-" + suffix;
            suffix++;
        }
        return candidate;
    }

    static String slug(String source) {
        String raw = source == null ? "" : source.trim().toLowerCase(Locale.ROOT);
        String slug = raw.replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        if (slug.isEmpty()) {
            slug = "connection";
        }
        if (slug.length() > 40) {
            slug = slug.substring(0, 40).replaceAll("-+$", "");
        }
        return slug;
    }

    private static void backupCorrupt(Path file) {
        try {
            String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
            Files.move(file, file.resolveSibling("connections.json.corrupt-" + stamp),
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) {
            // 备份失败时留原文件，下次读仍会降级为空列表
        }
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static String nullableText(Object value) {
        String raw = text(value);
        return raw.isBlank() ? null : raw;
    }

    private static int intValue(Object value) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        String raw = text(value);
        if (raw.isBlank()) {
            return 0;
        }
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String blankTo(String fallback, String value) {
        return value.isBlank() ? fallback : value;
    }
}

