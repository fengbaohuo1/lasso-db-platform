package com.jnf.dbservice;

import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 数据源注册表：内置演示库（H2 文件库，随数据目录创建并自动种数据）+ data/connections.json 里的存储数据源。
 * <p>密码策略：勾选 savePassword 时持久化（connections.json）；否则仅进程内缓存
 * （注册/更新/测试收到密码即缓存，进程重启失效），不写盘、不在列表接口返回。
 */
@Component
public class DataSourceRegistry {

    /** 进程内密码缓存（按 datasourceId）。 */
    private final Map<String, String> passwordCache = new ConcurrentHashMap<>();
    /** 目标签名兜底（host:port/db/user 或 jdbcUrl+user）。 */
    private final Map<String, String> signaturePasswords = new ConcurrentHashMap<>();
    /** id → 签名，删除时清理。 */
    private final Map<String, String> idSignatures = new ConcurrentHashMap<>();
    private static final int MAX_SIGNATURE_CACHE = 64;

    private final AppProperties properties;

    public DataSourceRegistry(AppProperties properties) {
        this.properties = properties;
    }

    /** kind: demo（内置演示库）/ stored（注册的数据源）；type: mysql / custom / h2-demo。 */
    public record DbConnection(String id, String name, String kind, String type, String host, int port,
                               String database, String jdbcUrl, String user, String password) {

        public boolean isDemo() {
            return "demo".equals(kind) || "demo".equals(id);
        }

        public boolean hasSavedPassword() {
            return password != null && !password.isBlank();
        }
    }

    /* ------------------------------ 密码缓存 ------------------------------ */

    void cachePassword(DbConnection connection, String password) {
        if (connection == null || password == null || password.isEmpty() || connection.isDemo()) {
            return;
        }
        if (connection.id() != null && !connection.id().isBlank()) {
            passwordCache.put(connection.id(), password);
        }
        String signature = signatureOf(connection);
        if (signature != null) {
            if (signaturePasswords.size() >= MAX_SIGNATURE_CACHE) {
                signaturePasswords.clear();
                idSignatures.clear();
            }
            signaturePasswords.put(signature, password);
            if (connection.id() != null && !connection.id().isBlank()) {
                idSignatures.put(connection.id(), signature);
            }
        }
    }

    void evictPassword(String datasourceId) {
        if (datasourceId == null || datasourceId.isBlank()) {
            return;
        }
        passwordCache.remove(datasourceId);
        String signature = idSignatures.remove(datasourceId);
        if (signature != null) {
            signaturePasswords.remove(signature);
        }
    }

    String cachedPassword(DbConnection connection) {
        if (connection == null || connection.isDemo()) {
            return null;
        }
        String byId = passwordCache.get(connection.id());
        if (byId != null) {
            return byId;
        }
        String signature = signatureOf(connection);
        return signature == null ? null : signaturePasswords.get(signature);
    }

    boolean passwordInMemory(DbConnection connection) {
        return connection != null && !connection.isDemo() && cachedPassword(connection) != null;
    }

    void disconnect(String datasourceId) {
        String key = datasourceId == null ? "" : datasourceId.trim();
        if (key.isEmpty()) {
            throw new IllegalArgumentException("id 不能为空");
        }
        require(key);
        evictPassword(key);
    }

    private static String signatureOf(DbConnection connection) {
        if (connection == null || connection.isDemo()) {
            return null;
        }
        String user = connection.user() == null ? "" : connection.user().trim();
        if (ConnectionSpec.TYPE_MYSQL.equals(connection.type())) {
            String host = connection.host() == null ? "" : connection.host().trim().toLowerCase(Locale.ROOT);
            String database = connection.database() == null ? "" : connection.database().trim();
            return "mysql://" + host + ":" + connection.port() + "/" + database + "|" + user;
        }
        String jdbcUrl = connection.jdbcUrl() == null ? "" : connection.jdbcUrl().trim();
        return "jdbc:" + jdbcUrl + "|" + user;
    }

    /* ------------------------------ 数据源清单 ------------------------------ */

    public Path dataDir() {
        return Path.of(properties.getDataDir()).toAbsolutePath().normalize();
    }

    public ConnectionStore store() {
        return new ConnectionStore(dataDir());
    }

    public List<ConnectionStore.StoredConnection> stored() {
        return store().load();
    }

    /** 清单 = demo + 存储数据源。 */
    public List<DbConnection> list() {
        List<DbConnection> connections = new ArrayList<>();
        try {
            Files.createDirectories(dataDir());
        } catch (Exception ignored) {
            // 目录失败时打开连接再报更具体的错
        }
        connections.add(demo());
        for (ConnectionStore.StoredConnection stored : stored()) {
            connections.add(new DbConnection(stored.id(), stored.name(), "stored", stored.type(),
                    stored.host(), stored.port(), stored.database(), stored.jdbcUrl(),
                    stored.user(), stored.password()));
        }
        return connections;
    }

    public DbConnection demo() {
        return new DbConnection("demo", "内置演示库（H2）", "demo", ConnectionSpec.TYPE_H2_DEMO,
                "127.0.0.1", 0, "demo",
                "jdbc:h2:file:" + dataDir().resolve("demo").toString().replace('\\', '/')
                        + ";DB_CLOSE_ON_EXIT=FALSE;DATABASE_TO_LOWER=TRUE",
                "sa", "");
    }

    public DbConnection require(String id) {
        String key = id == null || id.isBlank() ? "demo" : id.trim();
        return list().stream()
                .filter(connection -> connection.id().equals(key))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("数据源不存在: " + key
                        + "（可用: " + String.join(", ", list().stream().map(DbConnection::id).toList()) + "）"));
    }

    /** 打开连接；演示库首次打开自动建表+种子数据。密码：持久化优先，否则进程内缓存。 */
    public Connection open(DbConnection connection) throws SQLException {
        String url = connection.jdbcUrl();
        String driver = driverOf(url);
        if (driver != null) {
            try {
                Class.forName(driver);
            } catch (ClassNotFoundException ignored) {
                // 由 DriverManager 抛 no suitable driver
            }
        }
        DriverManager.setLoginTimeout(5);
        String password = connection.password();
        boolean passwordMissing = password == null || password.isBlank();
        if (passwordMissing) {
            String cached = cachedPassword(connection);
            if (cached != null) {
                password = cached;
                passwordMissing = false;
            }
        }
        try {
            Connection con = (connection.user() == null)
                    ? DriverManager.getConnection(url)
                    : DriverManager.getConnection(url, connection.user(), password == null ? "" : password);
            if (connection.isDemo()) {
                DemoSeeder.ensure(con);
            }
            return con;
        } catch (SQLException error) {
            throw mapLoginError(error, connection, passwordMissing);
        }
    }

    /** 连接测试：{ok,product,version,elapsedMs}；失败 {ok:false,error}。 */
    public Map<String, Object> test(DbConnection connection) {
        long started = System.currentTimeMillis();
        Map<String, Object> result = new java.util.LinkedHashMap<>();
        try (Connection con = open(connection)) {
            var meta = con.getMetaData();
            result.put("ok", true);
            result.put("product", meta.getDatabaseProductName());
            result.put("version", meta.getDatabaseProductVersion());
        } catch (Exception error) {
            result.put("ok", false);
            result.put("error", rootMessage(error));
        }
        result.put("elapsedMs", System.currentTimeMillis() - started);
        return result;
    }

    static String rootMessage(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }

    /** MySQL 1045 且无密码可用 → 可读提示（保留原始 code/state）。 */
    static SQLException mapLoginError(SQLException error, DbConnection connection, boolean passwordMissing) {
        if (!passwordMissing || connection == null) {
            return error;
        }
        String url = connection.jdbcUrl();
        if (url == null || !url.startsWith("jdbc:mysql:")) {
            return error;
        }
        if (connection.user() == null || connection.user().isBlank() || !isAccessDenied(error)) {
            return error;
        }
        String hint = "连接需要密码：该数据源未保存密码，当前进程也没有密码缓存（进程重启后缓存失效）。"
                + "请重新提交密码，或勾选“保存密码”后重试。"
                + "（原始错误 code=" + error.getErrorCode() + ", sqlState=" + error.getSQLState()
                + "：" + error.getMessage() + "）";
        return new SQLException(hint, error.getSQLState(), error.getErrorCode());
    }

    private static boolean isAccessDenied(SQLException error) {
        if (error.getErrorCode() == 1045) {
            return true;
        }
        String state = error.getSQLState();
        if (state != null && state.startsWith("28")) {
            return true;
        }
        String message = error.getMessage();
        return message != null && (message.toLowerCase(Locale.ROOT).contains("access denied")
                || message.toLowerCase(Locale.ROOT).contains("using password: no"));
    }

    private static String driverOf(String url) {
        if (url == null) {
            return null;
        }
        if (url.startsWith("jdbc:mysql:")) {
            return "com.mysql.cj.jdbc.Driver";
        }
        if (url.startsWith("jdbc:h2:")) {
            return "org.h2.Driver";
        }
        return null;
    }
}
