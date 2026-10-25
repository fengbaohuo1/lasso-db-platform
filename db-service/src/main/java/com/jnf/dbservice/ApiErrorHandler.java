package com.jnf.dbservice;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** 统一异常 → ApiResult（HTTP 200）；参数/业务错误 40000，未知异常 50000。 */
@RestControllerAdvice
public class ApiErrorHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiErrorHandler.class);

    @ExceptionHandler(ApiException.class)
    public ApiResult apiException(ApiException error) {
        return ApiResult.error(error.getCode(), error.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ApiResult illegalArgument(IllegalArgumentException error) {
        return ApiResult.error("40000", error.getMessage() == null ? "请求参数不合法" : error.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ApiResult unexpected(Exception error) {
        log.warn("未处理异常", error);
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        return ApiResult.error("50000", "服务内部错误: " + message);
    }
}
