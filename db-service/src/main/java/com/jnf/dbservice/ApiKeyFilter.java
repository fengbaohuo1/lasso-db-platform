package com.jnf.dbservice;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 可选鉴权：当环境变量（或测试属性）DB_SERVICE_API_KEY 非空时，/api/** 需带 X-API-Key。
 * <p>失败也返回 HTTP 200 + {code:40100}，保持统一响应约定。
 */
@Component
public class ApiKeyFilter extends OncePerRequestFilter {

    private static final String ENV_NAME = "DB_SERVICE_API_KEY";
    private final Environment environment;

    public ApiKeyFilter(Environment environment) {
        this.environment = environment;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String expected = environment.getProperty(ENV_NAME);
        String path = request.getRequestURI();
        // CORS 预检请求不带业务头（浏览器不会带 X-API-Key），必须放行给 Spring 的 CORS 处理器
        if (expected == null || expected.isBlank() || !path.startsWith("/api/") || "/api/health".equals(path)
                || "OPTIONS".equalsIgnoreCase(request.getMethod())) {
            chain.doFilter(request, response);
            return;
        }
        String provided = request.getHeader("X-API-Key");
        if (provided == null) {
            provided = "";
        }
        boolean matches = MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                provided.getBytes(StandardCharsets.UTF_8));
        if (matches) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(HttpServletResponse.SC_OK);
        // 让浏览器前端能读到 40100（否则会被 CORS 拦住，看不到业务错误）
        String origin = request.getHeader("Origin");
        response.setHeader("Access-Control-Allow-Origin", origin == null ? "*" : origin);
        response.setHeader("Vary", "Origin");
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":\"40100\",\"info\":\"缺少或错误的 X-API-Key\",\"data\":null}");
    }
}


