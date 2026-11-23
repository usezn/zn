"""Checks behind sanitize_tool_result: what the deep-data form refuses to walk and how an allowed output is
turned into JSON text without running code of the output's own classes. Private module: the public names are
imported and documented by zn_gate.rules."""

from __future__ import annotations

import _thread
import functools
import inspect
import itertools
import json
import sys
import types
from collections import namedtuple
from collections.abc import Iterable, Iterator, Mapping
from typing import Any, List, Optional, Tuple

# Limits of the deep-data form of sanitize_tool_result, the same as the walker of
# the guard (guard._DEFAULT_MAX_DEPTH and guard.MAX_OBJECT_VALUES): ten levels of
# dicts, lists, tuples and sets, and 100,000 values in all.
SANITIZE_MAX_DEPTH = 10
SANITIZE_MAX_ITEMS = 100_000


class SanitizeLimitError(ValueError):
    """Raised by sanitize_tool_result(data) for data it will not walk to mask: nested deeper
    than SANITIZE_MAX_DEPTH levels, a container that contains itself (rule size:nesting),
    more than SANITIZE_MAX_ITEMS values (rule size:items), or an object it cannot read or
    whose properties or attribute hooks it does not read (rule type:unscannable)."""

    def __init__(self, rule: str, reason: str):
        super().__init__(reason)
        self.rule = rule
        self.reason = reason


SanitizeLimitError.__module__ = "zn_gate.rules"  # public as zn_gate.rules.SanitizeLimitError


def _is_opaque_object(val: Any) -> bool:
    """True for a value that is not text, a number, a container or a plain scalar type: an instance of some class."""
    import datetime
    import decimal
    import enum
    import inspect
    import pathlib
    import types
    import uuid
    return not (
        val is None
        or isinstance(val, (str, bytes, bytearray, memoryview, bool, int, float, complex, type, types.ModuleType,
                            enum.Enum, decimal.Decimal, datetime.date, datetime.time, datetime.timedelta, uuid.UUID,
                            pathlib.PurePath))
        or inspect.isroutine(val)
    )


# Packages whose properties and attribute hooks only show values that a walk of __dict__ and __slots__ already
# reads: the standard library, zn_gate itself, the data-model libraries (pydantic, attrs, msgspec) and the
# message and node classes of LangChain and LlamaIndex.
_TRUSTED_ACCESSOR_PACKAGES = frozenset({
    "zn_gate", "pydantic", "pydantic_core", "attr", "attrs", "msgspec", "langchain_core", "llama_index",
})
# A class attribute named __class__ (a property or a plain value) changes what isinstance() answers.
_ACCESSOR_HOOKS = ("__getattr__", "__getattribute__", "__class__")
UNREAD_ACCESSORS_REASON = ("An object shows values through properties or attribute hooks that cannot be checked "
                           "without running its code; return its data as a dict instead")
# Values that unread_accessors never needs to look at: the plain containers and None, and text, numbers, classes
# and modules (subclasses included, as the scanners read them as such). Compared with the real type.
_PLAIN_VALUE_TYPES = frozenset({dict, list, tuple, set, frozenset, type(None)})
_SCALAR_TYPES = (str, bytes, bytearray, memoryview, bool, int, float, complex, type, types.ModuleType)
# The three class checks below (unread_accessors, overrides_builtin_reading, custom_text_form) answer from the class
# as it is at each check, never from an earlier answer: a class (or a class of its MRO, or the MRO itself) can gain
# a property, a hook or a text form after a first check that allowed it.


# The slots of `type` itself, read directly: a metaclass can override __mro__, __dict__, __module__ or
# __qualname__ with a property of its own, so the class's own answer is never asked for.
_TYPE_MRO = type.__dict__["__mro__"]


def _is_mapping(val: Any) -> bool:
    """isinstance(val, Mapping) from the real class: its MRO is compared by identity, so neither the registry of the
    ABC (which hashes and compares the class) nor a hook of its metaclass runs."""
    kind = type(val)
    return (issubclass(kind, (dict, types.MappingProxyType))
            or any(c is Mapping for c in _TYPE_MRO.__get__(kind)))


def _defines_all(val: Any, *names: str) -> bool:
    """True when the class of `val` defines every one of `names` (what the hooks of Iterator and Iterable ask), read
    through the namespaces of its MRO."""
    kind = type(val)
    return all(any(n in _TYPE_DICT.__get__(c) for c in _TYPE_MRO.__get__(kind)) for n in names)


def _is_iterator(val: Any) -> bool:
    return _defines_all(val, "__iter__", "__next__") or _defines_all(val, "__aiter__", "__anext__")


def _type_is(kind: Any, table: Any) -> bool:
    """True when `kind` is one of the types in `table`, compared by identity only. `kind in table` would call __eq__
    or __hash__ of the metaclass of `kind`, which a class of the output can define."""
    for known in table:
        if kind is known:
            return True
    return False


_TYPE_DICT = type.__dict__["__dict__"]
_TYPE_MODULE = type.__dict__["__module__"]
_TYPE_QUALNAME = type.__dict__["__qualname__"]
_TYPE_NAME = type.__dict__["__name__"]
_TYPE_FLAGS = type.__dict__["__flags__"]
_HEAPTYPE = 1 << 9
# Heap types written in C that their module does not bind under their qualified name, trusted by identity only:
# the lock of _thread, a heap type on Python 3.12 that _thread binds as LockType. A flag or a module name is not
# evidence (an extension module can create an immutable type under any module name).
_UNBOUND_C_TYPES: Tuple[type, ...] = (type(_thread.allocate_lock()),)
# The descriptor type of a namedtuple field, compared by identity (its name can be copied).
_TUPLEGETTER = type(vars(namedtuple("_ZnField", "a"))["a"])


def _trusted_module(module: Any) -> bool:
    top = module.split(".", 1)[0] if isinstance(module, str) else ""
    return top == "builtins" or top in sys.stdlib_module_names or top in _TRUSTED_ACCESSOR_PACKAGES


def _trusted_class(c: type) -> bool:
    """True for a class of the standard library or of a trusted package.

    A class written in Python can set __module__ (and __qualname__) to any name, so its module name is
    trusted only when that module, already imported, holds this very class under that qualified name.
    A static type (written in C) cannot change its module name.
    """
    if c is object:
        return True
    return _trusted_module(_TYPE_MODULE.__get__(c)) and _class_bound(c)


def _class_bound(c: type) -> bool:
    """True when the module that `c` names, already imported, holds this very class under its qualified name, or
    when `c` is a static type (written in C), which cannot change its module name, or one of the few heap types
    written in C that their module binds under another name (_UNBOUND_C_TYPES, compared by identity)."""
    module = _TYPE_MODULE.__get__(c)
    if not _TYPE_FLAGS.__get__(c) & _HEAPTYPE or any(c is known for known in _UNBOUND_C_TYPES):
        return True
    target: Any = sys.modules.get(module) if isinstance(module, str) else None
    for part in str(_TYPE_QUALNAME.__get__(c)).split("."):
        if isinstance(target, types.ModuleType):
            namespace: Any = vars(target)
        elif isinstance(target, type):
            namespace = _TYPE_DICT.__get__(target)
        else:
            return False
        target = namespace.get(part) if isinstance(namespace, (dict, types.MappingProxyType)) else None
    return target is c


def _type_defines(kind: type, name: str) -> bool:
    """True when a class of the MRO of `kind` holds `name` in its own namespace. Reads the namespaces through the slots
    of `type`, so a metaclass hook (__getattr__, a property) never runs, as hasattr(kind, name) could."""
    return any(name in _TYPE_DICT.__get__(c) for c in _TYPE_MRO.__get__(kind))


def _class_accessors(klass: type) -> Tuple[bool, Tuple[str, ...]]:
    """(whether a class of the MRO outside the trusted packages defines a data descriptor or an attribute hook,
    the names of its cached properties)."""
    lazy: List[str] = []
    for c in _TYPE_MRO.__get__(klass):
        if _trusted_class(c):
            continue
        for name, attr in list(_TYPE_DICT.__get__(c).items()):
            if name in _ACCESSOR_HOOKS:
                return True, ()
            kind = type(attr)
            if kind is functools.cached_property:
                lazy.append(attr.attrname or name)
                continue
            if _type_is(kind, (types.MemberDescriptorType, types.GetSetDescriptorType)):
                # __slots__ entries, __dict__ and __weakref__: what they hold is walked.
                continue
            if kind is _TUPLEGETTER and issubclass(klass, tuple):
                # A namedtuple field: an item of the tuple, which is walked.
                continue
            if _type_defines(kind, "__get__") and (_type_defines(kind, "__set__") or _type_defines(kind, "__delete__")):
                return True, ()
    return False, tuple(lazy)


def unread_accessors(val: Any) -> bool:
    """True when `val` can show values that a walk of its __dict__ and __slots__ does not read.

    That is the case when a class of its MRO, outside the standard library and the trusted packages
    (_TRUSTED_ACCESSOR_PACKAGES; see _trusted_class: a class that only names such a module is not trusted),
    defines a data descriptor (a property, or any descriptor with __get__ and __set__ or __delete__), a
    __getattr__ or __getattribute__ hook, a __class__ attribute, or a cached property not computed yet.
    Reading those would run the object's code (side effects, slowness, exceptions), so the scanners do not
    read them: a tool result with one is refused instead (rule type:unscannable), and the masker and the
    checker agree on it.
    """
    try:
        hidden, lazy = _class_accessors(type(val))
    except Exception:
        return True
    if hidden:
        return True
    if lazy:
        try:
            d = object.__getattribute__(val, "__dict__")
        except Exception:
            return True
        return not isinstance(d, dict) or any(n not in d for n in lazy)
    return False


# Built-in types that the scanners read through their own storage: the text of a str or bytes, the number of an
# int or float, the items of a list, tuple, set or dict. Compared with the real type.
_BUILTIN_READ_TYPES = (str, bytes, bytearray, int, float, complex, list, tuple, dict, set, frozenset)
_EXACT_BUILTIN_TYPES = frozenset({str, bytes, bytearray, int, bool, float, complex, list, tuple, dict, set, frozenset})
# Methods through which a subclass of one of them shows other content than the scanners read: str(), repr(),
# format() and f-strings, iteration, dict(), json, copy and pickle each use the storage or one of these.
_READING_HOOKS = frozenset({
    "__str__", "__repr__", "__format__", "__bytes__", "__iter__", "__reversed__", "__getitem__", "__len__",
    "__contains__", "keys", "items", "values", "get", "__reduce__", "__reduce_ex__", "__getstate__", "__copy__",
    "__deepcopy__", "__json__", "for_json", "_asdict", "tolist", "to_dict", "__index__", "__int__", "__float__",
    "__complex__",
})
OVERRIDDEN_READING_REASON = ("A value of a built-in type (str, list, dict...) redefines how it is read or turned "
                             "into text, so it could show something else than what was checked; return a plain "
                             "str, list or dict instead")


_NAMEDTUPLE_ASDICT_FN = _TYPE_DICT.__get__(namedtuple("_ZnFields", "a"))["_asdict"]


def _generated_namedtuple_asdict(klass: type, fn: Any) -> bool:
    """True for the _asdict that namedtuple wrote for `klass`: the very code of the one it writes, no closure or
    defaults, the same globals, and field names of the class that are identifiers (as for its __repr__)."""
    if type(fn) is not types.FunctionType or fn.__code__ is not _NAMEDTUPLE_ASDICT_FN.__code__:
        return False
    if fn.__closure__ != _NAMEDTUPLE_ASDICT_FN.__closure__ or fn.__defaults__ or fn.__kwdefaults__:
        return False
    fields = _TYPE_DICT.__get__(klass).get("_fields")
    if type(fields) is not tuple or not all(type(name) is str and name.isidentifier() for name in fields):
        return False
    return _same_globals(fn, _NAMEDTUPLE_ASDICT_FN)


def _class_overrides_reading(klass: type) -> bool:
    """True when a class of the MRO of `klass` that is not trusted (see _trusted_class, which checks that the
    module really holds the class) defines a method of _READING_HOOKS that is not, by identity, the method of the
    same name of a trusted class of the same MRO (enum copies Enum.__repr__ onto each enum class) or the __repr__
    or _asdict that namedtuple writes (compared by code, closure and globals). The __module__ that a function
    carries is never evidence: any code can set it."""
    mro = _TYPE_MRO.__get__(klass)
    trusted_methods = {(n, id(v)) for c in mro if _trusted_class(c) for n, v in _TYPE_DICT.__get__(c).items()}
    for c in mro:
        if _trusted_class(c):
            continue
        for name, attr in list(_TYPE_DICT.__get__(c).items()):
            if name not in _READING_HOOKS or (name, id(attr)) in trusted_methods:
                continue
            if name == "__repr__" and _generated_namedtuple_repr(c, attr):
                continue
            if name == "_asdict" and _generated_namedtuple_asdict(c, attr):
                continue
            return True
    return False


def overrides_builtin_reading(val: Any) -> bool:
    """True when `val` is an instance of a subclass of a built-in str, bytes, number, list, tuple, dict or set type
    that redefines a method in _READING_HOOKS outside the standard library and the trusted packages.

    The scanners read such a value through its built-in storage or its methods, and what turns it into text later
    (str(), json, dict(), a framework) may use the other one, so the text it shows may not be the text that was
    checked. A tool result holding one is refused (rule type:unscannable).
    """
    klass = type(val)
    if _type_is(klass, _EXACT_BUILTIN_TYPES) or not issubclass(klass, _BUILTIN_READ_TYPES):
        return False
    try:
        return _class_overrides_reading(klass)
    except Exception:
        return True


# Methods that decide the text of an object: str(), repr(), format() and f-strings, the repr() of a container
# that holds it, and os.fspath() (which the result check itself calls on a path-like object).
_TEXT_HOOKS = ("__str__", "__repr__", "__format__", "__fspath__")
CUSTOM_TEXT_REASON = ("An object defines its own text form (__str__, __repr__ or __format__), which could show "
                      "something else than the values that were checked; return its data as a dict instead")


def _sample_dataclass_repr() -> Any:
    import dataclasses

    @dataclasses.dataclass
    class _ZnSample:
        a: int

    return _TYPE_DICT.__get__(_ZnSample)["__repr__"]


# The code of the wrapper that dataclasses put around every __repr__ it writes (reprlib.recursive_repr, or the
# copy of it in dataclasses before Python 3.13) and of the __repr__ of every namedtuple, compared by identity.
_DATACLASS_REPR_WRAPPER = _sample_dataclass_repr().__code__
_NAMEDTUPLE_REPR_FN = _TYPE_DICT.__get__(namedtuple("_ZnText", "a"))["__repr__"]
_NAMEDTUPLE_REPR = _NAMEDTUPLE_REPR_FN.__code__


def _code_shape(code: Any) -> Tuple[Any, ...]:
    return (code.co_code, code.co_consts, code.co_names, code.co_varnames, code.co_freevars, code.co_cellvars)


_NO_GLOBAL = object()


@functools.lru_cache(maxsize=256)
def _loaded_globals(code: Any) -> frozenset[Any]:
    """The global names that `code` loads. Only asked for the code of a reference function that this module made."""
    import dis

    return frozenset(ins.argval for ins in dis.get_instructions(code) if ins.opname in ("LOAD_GLOBAL", "LOAD_NAME"))


def _same_globals(fn: Any, reference: Any) -> bool:
    """True when every global name that the code of `reference` loads is the very same object for `fn`, with the
    same builtins: a function can be rebuilt from trusted code with globals of its own."""
    if getattr(fn, "__builtins__", None) is not getattr(reference, "__builtins__", None):
        return False
    names = _loaded_globals(reference.__code__)
    return all(fn.__globals__.get(name, _NO_GLOBAL) is reference.__globals__.get(name, _NO_GLOBAL) for name in names)


@functools.lru_cache(maxsize=256)
def _reference_dataclass_repr(names: Tuple[str, ...]) -> Any:
    """The __repr__ that dataclasses writes for a class whose repr fields are `names`, or None when it cannot write
    one (a name that is not an identifier). Kept per field names: it depends only on them, and writing it is slow."""
    import dataclasses

    try:
        reference = dataclasses.make_dataclass("_ZnReference", [(name, object) for name in names])
    except (TypeError, ValueError, SyntaxError):
        return None
    return _TYPE_DICT.__get__(reference).get("__repr__")


def _same_wrapper_cells(fn: Any, reference: Any) -> Optional[Any]:
    """The inner function of `fn`, a repr wrapper with the code of `reference`, when every other cell of its closure
    holds what the cell of `reference` holds (the text shown for a repr that calls itself, "..."); None otherwise."""
    cells, expected = fn.__closure__ or (), reference.__closure__ or ()
    if len(cells) != len(expected):
        return None
    inner = None
    for cell, ref in zip(cells, expected, strict=True):
        value, ref_value = cell.cell_contents, ref.cell_contents
        if type(ref_value) is types.FunctionType:
            if type(value) is not types.FunctionType or inner is not None:
                return None
            inner = value
        elif type(ref_value) is set:
            if type(value) is not set:  # the ids of the objects being shown
                return None
        elif type(value) is not type(ref_value) or value != ref_value:
            return None
    return inner


def _generated_dataclass_repr(klass: type, fn: Any) -> bool:
    """True for the __repr__ that dataclasses wrote for `klass`: it shows the class name and the repr() of its fields,
    which are walked like any attribute. Recognized by comparing it with the __repr__ that dataclasses writes, here
    and now, for the same repr fields: the same wrapper code and closure, and an inner function with the same code
    (bytecode, constants and names). Never by a file name, a marker or a name, which any code can set."""
    fields = _TYPE_DICT.__get__(klass).get("__dataclass_fields__")
    if type(fn) is not types.FunctionType or fn.__code__ is not _DATACLASS_REPR_WRAPPER or type(fields) is not dict:
        return False
    import dataclasses

    names = []
    for name, field in fields.items():
        if type(field) is not dataclasses.Field or type(name) is not str:
            return False
        if getattr(field, "_field_type", None) is dataclasses._FIELD and field.repr is True:  # type: ignore[attr-defined]
            names.append(name)
    reference = _reference_dataclass_repr(tuple(names))
    if type(reference) is not types.FunctionType or reference.__code__ is not _DATACLASS_REPR_WRAPPER:
        return False
    inner, ref_inner = _same_wrapper_cells(fn, reference), _same_wrapper_cells(reference, reference)
    if inner is None or ref_inner is None or not _same_globals(fn, reference):
        return False
    if inner.__defaults__ or inner.__kwdefaults__ or _code_shape(inner.__code__) != _code_shape(ref_inner.__code__):
        return False
    cells = tuple(c.cell_contents for c in (inner.__closure__ or ()))
    ref_cells = tuple(c.cell_contents for c in (ref_inner.__closure__ or ()))
    return (len(cells) == len(ref_cells) and all(a is b for a, b in zip(cells, ref_cells, strict=True))
            and _same_globals(inner, ref_inner))


def _generated_namedtuple_repr(klass: type, fn: Any) -> bool:
    """True for the __repr__ that namedtuple wrote for `klass`: its code, and a closure whose only cell is the format
    namedtuple builds from the class's own field names. The code alone can be reused with another closure."""
    if type(fn) is not types.FunctionType or fn.__code__ is not _NAMEDTUPLE_REPR:
        return False
    fields = _TYPE_DICT.__get__(klass).get("_fields")
    if type(fields) is not tuple or not all(type(name) is str and name.isidentifier() for name in fields):
        return False
    cells = fn.__closure__ or ()
    if len(cells) != 1 or fn.__defaults__ or fn.__kwdefaults__:
        return False
    expected = "(" + ", ".join(f"{name}=%r" for name in fields) + ")"
    value = cells[0].cell_contents
    return type(value) is str and value == expected and _same_globals(fn, _NAMEDTUPLE_REPR_FN)


def _class_defines_text(klass: type) -> bool:
    mro = _TYPE_MRO.__get__(klass)
    trusted_methods = {id(v) for c in mro if _trusted_class(c) for v in _TYPE_DICT.__get__(c).values()}
    for c in mro:
        if _trusted_class(c):
            continue
        namespace = _TYPE_DICT.__get__(c)
        for name in _TEXT_HOOKS:
            if name not in namespace:
                continue
            fn = namespace[name]
            if id(fn) in trusted_methods:
                # The very method of a standard-library class (enum copies Enum.__repr__ onto each enum class).
                continue
            if name == "__repr__" and (_generated_namedtuple_repr(c, fn) or _generated_dataclass_repr(c, fn)):
                continue
            return True
    return False


def custom_text_form(val: Any) -> bool:
    """True when a class of the MRO of `val`, outside the standard library and the trusted packages (see
    _trusted_class), defines __str__, __repr__ or __format__.

    Such an object turns into text through its own code: str(), repr(), format(), an f-string, a log line or the repr()
    of a list that holds it can show text that no checked attribute holds, and a different text each time. A tool
    result holding one is refused (rule type:unscannable) by check_tool_result and sanitize_tool_result. The __repr__
    that dataclasses or namedtuple write (the class name and the repr() of the fields, which are checked; recognized
    by comparing their code and closure with what those helpers write) and the methods that enum copies from the
    standard library are not counted. The __repr__ that attrs writes is counted: nothing that a class cannot also
    set tells it apart from a hand-written one, and a per-attribute repr callable runs code of its own.
    """
    try:
        return _class_defines_text(type(val))
    except Exception:
        return True


def _object_names(val: Any) -> List[str]:
    """The attribute names of an instance of a class (__dict__ and __slots__), [] for anything else."""
    if not _is_opaque_object(val):
        return []
    names: List[str] = []
    try:
        try:
            d = object.__getattribute__(val, "__dict__")
        except AttributeError:
            d = None
        if type(d) is dict:
            for k in d:
                if type(k) is not str:
                    # A key of another type would be turned into text by its own code: refused, never coerced.
                    raise SanitizeLimitError("type:unscannable", "An object could not be read to mask it")
                names.append(k)
        for klass in _TYPE_MRO.__get__(type(val)):
            slots = _TYPE_DICT.__get__(klass).get("__slots__", ())
            for n in ((slots,) if isinstance(slots, str) else slots):
                if n in ("__dict__", "__weakref__"):
                    continue
                if n.startswith("__") and not n.endswith("__"):
                    n = "_" + _TYPE_NAME.__get__(klass).lstrip("_") + n
                if n not in names:
                    try:
                        object.__getattribute__(val, n)
                    except AttributeError:
                        continue
                    names.append(n)
    except Exception:
        # Attributes that cannot be listed cannot be masked: refuse instead of passing the object through unread.
        raise SanitizeLimitError("type:unscannable", "An object could not be read to mask it") from None
    return names


_EXACT_TEXT_TYPES = frozenset({str, bytes, bytearray, int, bool, float, complex, type(None)})
_TEXT_GRAPH_MAX_DEPTH = 64
_TEXT_GRAPH_MAX_VALUES = 100_000
_EXCEPTION_SLOT_READERS = tuple(BaseException.__dict__[name] for name in ("args", "__cause__", "__context__"))


def _screen_kind(val: Any) -> None:
    """SanitizeLimitError (rule type:unscannable) when the class of `val` shows it through code that is not trusted by
    identity: properties or attribute hooks (unread_accessors), its own text form (custom_text_form, the metaclass's for
    a class) or a redefined reading method of a built-in type (overrides_builtin_reading). Runs none of that code."""
    if _type_is(type(val), _EXACT_TEXT_TYPES):
        return
    if unread_accessors(val):
        raise SanitizeLimitError("type:unscannable", UNREAD_ACCESSORS_REASON)
    if custom_text_form(val):
        raise SanitizeLimitError("type:unscannable", CUSTOM_TEXT_REASON)
    if overrides_builtin_reading(val):
        raise SanitizeLimitError("type:unscannable", OVERRIDDEN_READING_REASON)


def _text_children(val: Any) -> List[Any]:
    """What str() or repr() of `val` (screened by _screen_kind) shows the text of, read through the built-in storage:
    items of a dict, list, tuple or set (subclasses included), the object and function of a bound method, the parts
    of a functools.partial, the args, cause and context of an exception, the __dict__ and __slots__ of an object, and
    the items of another standard-library container. A class, a module or a function shows only its name."""
    if isinstance(val, dict):
        return [part for item in dict.items(val) for part in item]
    if isinstance(val, list):
        return list(list.__iter__(val))
    if isinstance(val, tuple):
        return list(tuple.__iter__(val))
    if isinstance(val, frozenset):
        return list(frozenset.__iter__(val))
    if isinstance(val, set):
        return list(set.__iter__(val))
    if isinstance(val, types.MethodType):
        return [val.__self__, val.__func__]
    if isinstance(val, (type, types.ModuleType)) or inspect.isroutine(val):
        return []
    if isinstance(val, functools.partial):
        return [val.func, val.args, val.keywords]
    children: List[Any] = []
    if isinstance(val, BaseException):
        children.extend(slot.__get__(val) for slot in _EXCEPTION_SLOT_READERS)
    try:
        attrs = object.__getattribute__(val, "__dict__")
    except AttributeError:
        attrs = None
    if type(attrs) is dict:
        children.extend(dict.values(attrs))
    for klass in _TYPE_MRO.__get__(type(val)):
        slots = _TYPE_DICT.__get__(klass).get("__slots__", ())
        for name in ((slots,) if isinstance(slots, str) else slots):
            if isinstance(name, str) and name not in ("__dict__", "__weakref__"):
                try:
                    children.append(object.__getattribute__(val, name))
                except AttributeError:
                    continue
    if _trusted_class(type(val)) and not isinstance(val, (Iterator, str, bytes, bytearray, memoryview)):
        if isinstance(val, Mapping):
            items = itertools.islice(val.items(), _TEXT_GRAPH_MAX_VALUES + 1)
            children.extend(part for item in items for part in item)
        elif isinstance(val, Iterable):
            children.extend(itertools.islice(val, _TEXT_GRAPH_MAX_VALUES + 1))
    return children


def _screen_text_graph(content: Any) -> None:
    """SanitizeLimitError when turning `content` into text (json, str(), repr()) could run code of the output: every
    value that the text shows is screened by _screen_kind before anything turns it into text. Deeper than
    _TEXT_GRAPH_MAX_DEPTH levels or more than _TEXT_GRAPH_MAX_VALUES values is refused too."""
    seen: set[int] = set()
    keep: List[Any] = []  # keeps the ids in `seen` from being reused during the walk
    stack: List[Tuple[Any, int]] = [(content, 0)]
    while stack:
        val, depth = stack.pop()
        if _type_is(type(val), _EXACT_TEXT_TYPES) or id(val) in seen:
            continue
        if depth > _TEXT_GRAPH_MAX_DEPTH:
            raise SanitizeLimitError("size:nesting", "The output is nested too deeply to check")
        seen.add(id(val))
        keep.append(val)
        if len(seen) > _TEXT_GRAPH_MAX_VALUES:
            raise SanitizeLimitError("size:items", "The output holds too many values to check")
        _screen_kind(val)
        try:
            children = _text_children(val)
        except SanitizeLimitError:
            raise
        except Exception:
            raise SanitizeLimitError("type:unscannable", "An object could not be read to check it") from None
        stack.extend((child, depth + 1) for child in children)


def _checked_text(val: Any) -> str:
    """str() of a value that json cannot write as it is (a set, a dataclass, a datetime...), once _screen_kind has
    found that its class shows it through trusted code only."""
    _screen_kind(val)
    return str(val)


def _checked_json(content: Any) -> str:
    """The JSON text of a tool output that check_tool_result allowed, as Node.js writes it. Every value its text
    shows is screened first (_screen_text_graph), so no __str__, __repr__ or reading method of the output's own
    classes runs: such an output raises SanitizeLimitError (rule type:unscannable) instead. A value json cannot
    write is written as its str() (_checked_text); a container that contains itself or keys json cannot write give
    str() of the whole output."""
    _screen_text_graph(content)
    try:
        return json.dumps(content, ensure_ascii=False, default=_checked_text)
    except SanitizeLimitError:
        raise
    except (TypeError, ValueError, RecursionError):
        return str(content)
