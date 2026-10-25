package com.jnf.dbservice;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** 服务配置（application.yml 的 db-service.*，均可用启动参数覆盖）。 */
@ConfigurationProperties(prefix = "db-service")
public class AppProperties {

    /** 数据目录：connections.json / demo.mv.db / incremental.json / logs。 */
    private String dataDir = "./data";
    /** 写操作（execute / rows/*）总开关；请求仍需 confirmed=true。 */
    private boolean allowWrite = false;
    /** 单次查询/数据浏览默认返回上限。 */
    private int maxRows = 200;
    /** 增量读取单页上限。 */
    private int incrementalMaxLimit = 1000;

    public String getDataDir() {
        return dataDir;
    }

    public void setDataDir(String dataDir) {
        this.dataDir = dataDir;
    }

    public boolean isAllowWrite() {
        return allowWrite;
    }

    public void setAllowWrite(boolean allowWrite) {
        this.allowWrite = allowWrite;
    }

    public int getMaxRows() {
        return maxRows;
    }

    public void setMaxRows(int maxRows) {
        this.maxRows = maxRows;
    }

    public int getIncrementalMaxLimit() {
        return incrementalMaxLimit;
    }

    public void setIncrementalMaxLimit(int incrementalMaxLimit) {
        this.incrementalMaxLimit = incrementalMaxLimit;
    }
}
