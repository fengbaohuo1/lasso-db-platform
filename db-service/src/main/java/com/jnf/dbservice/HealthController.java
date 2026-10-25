package com.jnf.dbservice;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/** 健康检查（无需 API Key）。 */
@RestController
public class HealthController {

    private final AppProperties properties;

    public HealthController(AppProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/api/health")
    public ApiResult health() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("ok", true);
        data.put("service", "db-service");
        data.put("dataDir", properties.getDataDir());
        data.put("allowWrite", properties.isAllowWrite());
        return ApiResult.ok(data);
    }
}
