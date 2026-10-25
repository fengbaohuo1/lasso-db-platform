package com.jnf.dbservice;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON：序列化 + 解析（插件不额外引入 Jackson/Gson，避免和宿主类加载器打架）。
 * <p>解析结果：对象 → {@link LinkedHashMap}，数组 → {@link ArrayList}，数字 → {@link Double}/{@link Long}，
 * 其余为 {@link String}/{@link Boolean}/null。
 */
final class Json {

    private Json() {
    }

    static String write(Object value) {
        StringBuilder sb = new StringBuilder(256);
        append(sb, value);
        return sb.toString();
    }

    private static void append(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
            return;
        }
        if (value instanceof String s) {
            escape(sb, s);
            return;
        }
        if (value instanceof Boolean || value instanceof Number) {
            sb.append(value);
            return;
        }
        if (value instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                escape(sb, String.valueOf(entry.getKey()));
                sb.append(':');
                append(sb, entry.getValue());
            }
            sb.append('}');
            return;
        }
        if (value instanceof List<?> list) {
            sb.append('[');
            boolean first = true;
            for (Object item : list) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                append(sb, item);
            }
            sb.append(']');
            return;
        }
        escape(sb, String.valueOf(value));
    }

    private static void escape(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    /* ------------------------------ 解析 ------------------------------ */

    /** 解析 JSON 文本；非法输入抛 {@link IllegalArgumentException}。 */
    static Object parse(String text) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("JSON 内容为空");
        }
        Parser parser = new Parser(text);
        Object value = parser.readValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw new IllegalArgumentException("JSON 尾部有多余内容（位置 " + parser.pos + "）");
        }
        return value;
    }

    /** 解析 JSON 对象；顶层不是对象时抛 {@link IllegalArgumentException}。 */
    @SuppressWarnings("unchecked")
    static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("请求体必须是 JSON 对象");
        }
        return (Map<String, Object>) map;
    }

    private static final class Parser {
        private final String text;
        private int pos;

        Parser(String text) {
            this.text = text;
        }

        boolean atEnd() {
            return pos >= text.length();
        }

        void skipWhitespace() {
            while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) {
                pos++;
            }
        }

        Object readValue() {
            skipWhitespace();
            if (atEnd()) {
                throw fail("JSON 意外结束");
            }
            char c = text.charAt(pos);
            return switch (c) {
                case '{' -> readObject();
                case '[' -> readArray();
                case '"' -> readString();
                case 't' -> readLiteral("true", Boolean.TRUE);
                case 'f' -> readLiteral("false", Boolean.FALSE);
                case 'n' -> readLiteral("null", null);
                default -> readNumber();
            };
        }

        private Map<String, Object> readObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // {
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                String key = readString();
                skipWhitespace();
                expect(':');
                map.put(key, readValue());
                skipWhitespace();
                char c = next();
                if (c == '}') {
                    return map;
                }
                if (c != ',') {
                    throw fail("对象成员之间缺少逗号");
                }
            }
        }

        private List<Object> readArray() {
            List<Object> list = new ArrayList<>();
            pos++; // [
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return list;
            }
            while (true) {
                list.add(readValue());
                skipWhitespace();
                char c = next();
                if (c == ']') {
                    return list;
                }
                if (c != ',') {
                    throw fail("数组元素之间缺少逗号");
                }
            }
        }

        private String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (!atEnd()) {
                char c = next();
                if (c == '"') {
                    return sb.toString();
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (atEnd()) {
                    break;
                }
                char esc = next();
                switch (esc) {
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        if (pos + 4 > text.length()) {
                            throw fail("\\u 转义不完整");
                        }
                        sb.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                        pos += 4;
                    }
                    default -> throw fail("未知转义字符: \\" + esc);
                }
            }
            throw fail("字符串未闭合");
        }

        private Object readLiteral(String literal, Object value) {
            if (!text.startsWith(literal, pos)) {
                throw fail("非法字面量");
            }
            pos += literal.length();
            return value;
        }

        private Object readNumber() {
            int start = pos;
            while (pos < text.length() && "-+.0123456789eE".indexOf(text.charAt(pos)) >= 0) {
                pos++;
            }
            String raw = text.substring(start, pos);
            if (raw.isEmpty()) {
                throw fail("非法值: " + text.charAt(start));
            }
            try {
                if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
                    return Double.parseDouble(raw);
                }
                long value = Long.parseLong(raw);
                return value >= Integer.MIN_VALUE && value <= Integer.MAX_VALUE ? (int) value : value;
            } catch (NumberFormatException e) {
                throw fail("非法数字: " + raw);
            }
        }

        private char peek() {
            return atEnd() ? '\0' : text.charAt(pos);
        }

        private char next() {
            if (atEnd()) {
                throw fail("JSON 意外结束");
            }
            return text.charAt(pos++);
        }

        private void expect(char expected) {
            char actual = next();
            if (actual != expected) {
                throw fail("期望 '" + expected + "' 但遇到 '" + actual + "'");
            }
        }

        private IllegalArgumentException fail(String message) {
            return new IllegalArgumentException(message + "（位置 " + pos + "）");
        }
    }
}

