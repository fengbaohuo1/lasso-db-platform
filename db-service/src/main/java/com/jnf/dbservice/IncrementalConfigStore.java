package com.jnf.dbservice;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 增量读取配置存储：data/incremental.json。
 * <pre>{"version":1,"configs":{"&lt;datasourceId&gt;":{"&lt;table&gt;":{"watermarkColumn":"id","primaryKey":"id","updatedAt":"..."}}}}</pre>
 */
@Component
public class IncrementalConfigStore {

    private static final int FORMAT_VERSION = 1;

    private final DataSourceRegistry registry;

    public IncrementalConfigStore(DataSourceRegistry registry) {
        this.registry = registry;
    }

    private Path file() {
        return registry.dataDir().resolve("incremental.json");
    }

    @SuppressWarnings("unchecked")
    private synchronized Map<String, Object> loadRoot() {
        Path path = file();
        if (!Files.isRegularFile(path)) {
            return newRoot();
        }
        try {
            String text = Files.readString(path, StandardCharsets.UTF_8);
            if (text.isBlank()) {
                return newRoot();
            }
            Map<String, Object> root = Json.parseObject(text);
            if (!(root.get("configs") instanceof Map)) {
                root.put("configs", new LinkedHashMap<String, Object>());
            }
            return root;
        } catch (Exception broken) {
            return newRoot();
        }
    }

    private Map<String, Object> newRoot() {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("version", FORMAT_VERSION);
        root.put("configs", new LinkedHashMap<String, Object>());
        return root;
    }

    private synchronized void saveRoot(Map<String, Object> root) {
        try {
            Path dir = registry.dataDir();
            Files.createDirectories(dir);
            Path target = file();
            Path temp = dir.resolve("incremental.json.tmp");
            Files.writeString(temp, Json.write(root), StandardCharsets.UTF_8);
            Files.move(temp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException error) {
            throw new ApiException("50000", "增量配置写入失败: " + error.getMessage(), error);
        }
    }

    @SuppressWarnings("unchecked")
    public synchronized Map<String, Object> get(String datasourceId, String table) {
        Map<String, Object> root = loadRoot();
        if (root.get("configs") instanceof Map<?, ?> configs) {
            Object byDatasource = configs.get(datasourceId);
            if (byDatasource instanceof Map<?, ?> tables) {
                Object config = tables.get(table);
                if (config instanceof Map<?, ?> map) {
                    return new LinkedHashMap<>((Map<String, Object>) map);
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    public synchronized void put(String datasourceId, String table, Map<String, Object> config) {
        Map<String, Object> root = loadRoot();
        Map<String, Object> configs = (Map<String, Object>) root.get("configs");
        Map<String, Object> tables = (Map<String, Object>) configs.computeIfAbsent(datasourceId,
                ignored -> new LinkedHashMap<String, Object>());
        tables.put(table, config);
        saveRoot(root);
    }

    @SuppressWarnings("unchecked")
    public synchronized void deleteDatasource(String datasourceId) {
        Map<String, Object> root = loadRoot();
        Map<String, Object> configs = (Map<String, Object>) root.get("configs");
        if (configs.remove(datasourceId) != null) {
            saveRoot(root);
        }
    }
}
