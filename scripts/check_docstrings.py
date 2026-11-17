"""检查后端、迁移和脚本的 public 定义是否带有 docstring。"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("app", "desktop", "migrations", "scripts")
ROUTE_DECORATORS = {
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "post",
    "put",
    "route",
    "websocket",
}


def _decorator_name(decorator: ast.expr) -> str:
    """提取装饰器末段名称，兼容直接调用和带参数的路由装饰器。"""
    if isinstance(decorator, ast.Call):
        return _decorator_name(decorator.func)
    if isinstance(decorator, ast.Attribute):
        return decorator.attr
    if isinstance(decorator, ast.Name):
        return decorator.id
    return ""


def _is_route(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """识别 HTTP 与 WebSocket 路由，避免私有命名的端点绕过检查。"""
    return any(_decorator_name(item) in ROUTE_DECORATORS for item in node.decorator_list)


class _DefinitionVisitor(ast.NodeVisitor):
    """记录 public 定义及其限定名称，同时保留嵌套方法和路由上下文。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.parents: list[str] = []
        self.missing: list[tuple[Path, int, str]] = []
        self.checked = 0

    def _visit_definition(
        self,
        node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef,
    ) -> None:
        """检查当前定义并递归访问嵌套定义，私有路由仍属于检查范围。"""
        is_public = not node.name.startswith("_")
        is_route = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _is_route(node)
        if is_public or is_route:
            self.checked += 1
            if not ast.get_docstring(node, clean=False):
                qualified_name = ".".join([*self.parents, node.name])
                self.missing.append((self.path, node.lineno, qualified_name))
        self.parents.append(node.name)
        self.generic_visit(node)
        self.parents.pop()

    visit_ClassDef = _visit_definition
    visit_FunctionDef = _visit_definition
    visit_AsyncFunctionDef = _visit_definition


def main() -> int:
    """遍历全部目标 Python 文件，列出缺失位置并在存在缺口时返回失败。"""
    missing: list[tuple[Path, int, str]] = []
    checked = 0
    for target in TARGETS:
        for path in sorted((ROOT / target).rglob("*.py")):
            if {"node_modules", ".venv", "dist", "build"} & set(path.parts):
                continue
            visitor = _DefinitionVisitor(path.relative_to(ROOT))
            visitor.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
            missing.extend(visitor.missing)
            checked += visitor.checked

    for path, lineno, name in missing:
        print(f"{path}:{lineno}: 缺少 docstring: {name}")
    if missing:
        print(f"检查失败：{checked} 个定义中有 {len(missing)} 个缺少 docstring。")
        return 1
    print(f"检查通过：{checked} 个 public 定义及 HTTP 路由均有 docstring。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
