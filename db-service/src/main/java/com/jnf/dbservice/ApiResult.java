package com.jnf.dbservice;

/**
 * 统一响应：HTTP 状态固定 200，业务结果看 code（00000 成功，其它为错误码）。
 */
public record ApiResult(String code, String info, Object data) {

    public static ApiResult ok(Object data) {
        return new ApiResult("00000", "success", data);
    }

    public static ApiResult error(String code, String info) {
        return new ApiResult(code, info, null);
    }
}
