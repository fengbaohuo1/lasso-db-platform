package com.jnf.dbservice;

/** 业务异常：携带统一响应码（HTTP 仍为 200，由异常处理器转成 ApiResult）。 */
public class ApiException extends RuntimeException {

    private final String code;

    public ApiException(String message) {
        this("40000", message);
    }

    public ApiException(String code, String message) {
        super(message);
        this.code = code;
    }

    public ApiException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public String getCode() {
        return code;
    }
}
