package com.jnf.dbservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * db-manager 数据源服务：独立后端（Spring Boot），提供数据源注册、元数据/数据浏览、
 * 行级编辑，以及面向 Agent 的紧凑查询与增量读取接口。
 * <p>不依赖 jnf-harness 插件宿主；数据目录默认 ./data，端口默认 18090。
 */
@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
public class DbServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(DbServiceApplication.class, args);
    }
}
