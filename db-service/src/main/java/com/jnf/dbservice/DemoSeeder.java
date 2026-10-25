package com.jnf.dbservice;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * 演示库种子：首次连接空的演示库时建 4 张业务表 + 1 个视图，并写入中文演示数据。
 * <p>演示数据只用于本地体验与验收，不代表真实业务。
 */
final class DemoSeeder {

    private DemoSeeder() {
    }

    private static final String[] DDL = {
            "CREATE TABLE customers (id BIGINT PRIMARY KEY, name VARCHAR(64) NOT NULL, city VARCHAR(32),"
                    + " level VARCHAR(16), created_at TIMESTAMP)",
            "CREATE TABLE products (id BIGINT PRIMARY KEY, name VARCHAR(64) NOT NULL, category VARCHAR(32),"
                    + " price DECIMAL(12,2), stock INT)",
            "CREATE TABLE orders (id BIGINT PRIMARY KEY, order_no VARCHAR(32) NOT NULL UNIQUE, customer_id BIGINT,"
                    + " status VARCHAR(16), total_amount DECIMAL(12,2), created_at TIMESTAMP)",
            "CREATE TABLE order_items (id BIGINT PRIMARY KEY, order_id BIGINT, product_id BIGINT,"
                    + " quantity INT, unit_price DECIMAL(12,2))",
            "CREATE VIEW v_order_summary AS SELECT o.id, o.order_no, c.name AS customer_name, o.status,"
                    + " o.total_amount FROM orders o JOIN customers c ON c.id = o.customer_id"
    };

    private static final String[] DATA = {
            "INSERT INTO customers (id, name, city, level, created_at) VALUES"
                    + " (1,'张伟','杭州','金卡',TIMESTAMP '2025-03-12 10:20:00'),"
                    + " (2,'李娜','上海','银卡',TIMESTAMP '2025-05-08 14:05:00'),"
                    + " (3,'王强','北京','普通',TIMESTAMP '2025-06-30 09:12:00'),"
                    + " (4,'刘敏','深圳','金卡',TIMESTAMP '2025-08-21 16:40:00'),"
                    + " (5,'陈晨','成都','银卡',TIMESTAMP '2026-01-15 11:30:00'),"
                    + " (6,'赵磊','杭州','普通',TIMESTAMP '2026-03-02 08:55:00')",
            "INSERT INTO products (id, name, category, price, stock) VALUES"
                    + " (101,'机械键盘 K8','外设',399.00,120),"
                    + " (102,'人体工学椅 E3','办公家具',1299.00,35),"
                    + " (103,'27 寸 4K 显示器','显示设备',1899.00,58),"
                    + " (104,'降噪耳机 Pro','音频',899.00,76),"
                    + " (105,'USB-C 扩展坞','配件',299.00,210),"
                    + " (106,'笔记本支架','配件',129.00,340),"
                    + " (107,'无线鼠标 M5','外设',199.00,0),"
                    + " (108,'桌面显示器灯','照明',259.00,88)",
            "INSERT INTO orders (id, order_no, customer_id, status, total_amount, created_at) VALUES"
                    + " (1,'SO20261001001',1,'DONE',1899.00,TIMESTAMP '2026-10-01 09:15:00'),"
                    + " (2,'SO20261003002',2,'DONE',1299.00,TIMESTAMP '2026-10-03 14:22:00'),"
                    + " (3,'SO20261005003',3,'SHIPPED',798.00,TIMESTAMP '2026-10-05 10:05:00'),"
                    + " (4,'SO20261007004',4,'PAID',1899.00,TIMESTAMP '2026-10-07 16:48:00'),"
                    + " (5,'SO20261009005',5,'DONE',1299.00,TIMESTAMP '2026-10-09 11:30:00'),"
                    + " (6,'SO20261011006',6,'REFUND',399.00,TIMESTAMP '2026-10-11 09:02:00'),"
                    + " (7,'SO20261013007',1,'SHIPPED',899.00,TIMESTAMP '2026-10-13 15:10:00'),"
                    + " (8,'SO20261015008',2,'PAID',259.00,TIMESTAMP '2026-10-15 13:40:00'),"
                    + " (9,'SO20261017009',3,'DONE',299.00,TIMESTAMP '2026-10-17 10:55:00'),"
                    + " (10,'SO20261019010',4,'SHIPPED',199.00,TIMESTAMP '2026-10-19 17:05:00'),"
                    + " (11,'SO20261021011',5,'DONE',129.00,TIMESTAMP '2026-10-21 09:45:00'),"
                    + " (12,'SO20261023012',6,'DONE',1899.00,TIMESTAMP '2026-10-23 14:18:00')",
            "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES"
                    + " (1,1,103,1,1899.00), (2,2,102,1,1299.00), (3,3,101,2,399.00),"
                    + " (4,4,103,1,1899.00), (5,5,102,1,1299.00), (6,6,101,1,399.00),"
                    + " (7,7,104,1,899.00), (8,8,108,1,259.00), (9,9,105,1,299.00),"
                    + " (10,10,107,1,199.00), (11,11,106,1,129.00), (12,12,103,1,1899.00),"
                    + " (13,3,105,1,299.00), (14,4,105,1,299.00), (15,5,105,1,299.00),"
                    + " (16,7,106,1,129.00), (17,9,106,1,129.00), (18,10,106,1,129.00),"
                    + " (19,12,108,1,259.00), (20,2,106,2,129.00)"
    };

    /** 幂等：库为空才建表写数据。 */
    static void ensure(Connection connection) throws SQLException {
        if (tableCount(connection) > 0) {
            return;
        }
        boolean autoCommit = connection.getAutoCommit();
        connection.setAutoCommit(false);
        try (Statement statement = connection.createStatement()) {
            for (String ddl : DDL) {
                statement.execute(ddl);
            }
            for (String data : DATA) {
                statement.executeUpdate(data);
            }
            connection.commit();
        } catch (SQLException e) {
            connection.rollback();
            throw e;
        } finally {
            connection.setAutoCommit(autoCommit);
        }
    }

    private static int tableCount(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(
                     "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE UPPER(TABLE_SCHEMA) = 'PUBLIC'"
                             + " AND UPPER(TABLE_TYPE) = 'BASE TABLE'")) {
            return rs.next() ? rs.getInt(1) : 0;
        }
    }
}

