"""Keyed person names and postal addresses in the Python PII layer (find_pii_spans, mask_pii_preview).

The Node.js scrubber finds a name or an address only next to an explicit key; the Python port does the same with the
same checks (packages/zn-gate/lib/scrub/patterns.js). The shared corpus test/fixtures/pii_parity_cases.json holds the
exact spans; these tests add the longer lists of values, with the false-positive guards, and the CJK, JSON and
"ship to" forms. Every value is invented.
"""

from urllib.parse import quote

import pytest

from zn_gate import rules as R


def kinds(text, kind):
    return [text[a:b] for a, b, k in R.find_pii_spans(text) if k == kind]


def q(key, value):
    return "?%s=%s" % (key, quote(value, safe=""))


TITLES = ["Wireless Headphones Pro", "The Great Escape", "Oxford Street", "Acme Widgets Inc", "Starter Kit Plus", "Los Angeles",
          "Calle Mayor", "Hotel Playa Azul", "Rue de Rivoli", "Les Miserables", "Rua Augusta", "Avenida da Liberdade", "New York",
          "Summer Sale Collection", "Deluxe Edition Bundle", "Museo Nacional", "Quick Start Manual", "Praça do Comércio"]
NAMES = ["Marisol Quintanilla", "Patrick O'Brien", "Mary-Jane Watson", "Susan Park", "Tom Lane", "Max Bridge", "Carlos Plaza",
         "María José García López", "Maria dos Santos", "João das Neves", "Jean-Pierre Marchand", "Daniel Newman", "Fatima Al-Sayed",
         "Joaquín de la Torre"]
SHORT_VALUES = ["A1 B2", "v2 ok", "Version 2 ok", "Windows 11 Pro", "Room 12", "Step 3 of 5", "Order 1234 ok", "Route 66", "Q4 2026 plan", "iPhone 15 case"]
ADDRESSES = ["Calle Mayor 12, 28013 Madrid", "12 Baker Street, London NW1 6XE", "221B Baker Street London", "45 Rue de la Paix, 75002 Paris",
             "Rua Augusta 100, 1100-053 Lisboa", "Hauptstraße 5, 10115 Berlin", "Via Roma 10, 00184 Roma", "12 Baker Row London", "78 Oak Lane",
             "Avenida Paulista 1000, São Paulo", "1 Example Street", "北京市朝阳区建国路88号", "上海市浦东新区世纪大道100号"]


@pytest.mark.parametrize("key", ["name", "full_name"])
def test_titles_are_not_person_names(key):
    for t in TITLES:
        assert kinds(q(key, t), "PERSON_NAME") == [], t
    assert kinds("X-User-Name: The Great Escape", "PERSON_NAME") == []
    assert kinds("name=Lord of the rings", "PERSON_NAME") == []


@pytest.mark.parametrize("key", ["name", "full_name"])
def test_real_names_are_found(key):
    for n in NAMES:
        assert len(kinds(q(key, n), "PERSON_NAME")) == 1, n
    assert len(kinds("X-User-Name: Susan Park", "PERSON_NAME")) == 1


def test_han_names():
    for n in ["王小明", "李伟", "张海燕", "欧阳娜娜", "诸葛亮", "周杰"]:
        for key in ("name", "full_name"):
            assert len(kinds(q(key, n), "PERSON_NAME")) == 1, (key, n)
    for v in ["北京", "上海市", "苹果手机", "朝阳区", "建国路", "无线耳机", "人民医院", "李", "王小明小明"]:
        for key in ("name", "full_name"):
            assert kinds(q(key, v), "PERSON_NAME") == [], (key, v)
    assert kinds("王小明", "PERSON_NAME") == []   # a bare value, without its key, is never matched


def test_short_values_are_not_addresses():
    for v in SHORT_VALUES:
        assert kinds(q("address", v), "POSTAL_ADDRESS") == [], v


def test_addresses_are_found():
    for v in ADDRESSES:
        assert len(kinds(q("address", v), "POSTAL_ADDRESS")) == 1, v
    assert len(kinds("X-Address: 1 Example Street, Springfield", "POSTAL_ADDRESS")) == 1


def test_full_name_label_and_json_key():
    assert kinds('full_name: "Juan Perez Falso"', "PERSON_NAME") == ["Juan Perez Falso"]
    assert kinds('{"full_name": "Ana Imaginaria Lopez", "id": 7}', "PERSON_NAME") == ["Ana Imaginaria Lopez"]
    assert kinds("Full name: Maria Ejemplo Ficticia", "PERSON_NAME") == ["Maria Ejemplo Ficticia"]
    for text in ("full_name: str", "full_name: string", '{"full_name": "string"}', "full_name: the user full name", "full_name: Maria",
                 "full_name: null", "full_name: {{ user.name }}", "def f(full_name: str): ...", "user_full_name: Maria Ejemplo"):
        assert kinds(text, "PERSON_NAME") == [], text


def test_cjk_name_labels():
    assert kinds("姓名：山田太郎 電話", "PERSON_NAME") == ["山田太郎"]
    assert kinds("姓名: 王小明, 年龄 30", "PERSON_NAME") == ["王小明"]
    assert kinds('氏名:"佐藤花子"', "PERSON_NAME") == ["佐藤花子"]
    assert kinds("성명: 김민준 연락처", "PERSON_NAME") == ["김민준"]
    for text in ("姓名：必填", "姓名：", "姓名：A", "姓名 山田太郎", "姓名：山田太郎山田太郎山田太郎山田太郎"):
        assert kinds(text, "PERSON_NAME") == [], text


def test_street_keys_and_ship_to():
    assert kinds('"street": "45 Invented Avenue", "zip": "00000"', "POSTAL_ADDRESS") == ["45 Invented Avenue"]
    assert kinds("street: 12 Imaginary Road\ncity: Nowhere", "POSTAL_ADDRESS") == ["12 Imaginary Road"]
    assert kinds('{"street_address":"9 Fake Lane, Faketown"}', "POSTAL_ADDRESS") == ["9 Fake Lane, Faketown"]
    assert kinds("ship to: 742 Evergreen Terrace, Springfield", "POSTAL_ADDRESS") == ["742 Evergreen Terrace, Springfield"]
    assert kinds("Shipping to 10 Downing Street London", "POSTAL_ADDRESS") == ["10 Downing Street London"]
    assert kinds("ship to Calle Mayor 12, Madrid", "POSTAL_ADDRESS") == ["Calle Mayor 12, Madrid"]
    for text in ('"street": "Main"', '"street": "string"', "we ship to 3 customers in the EU", "ship to the warehouse",
                 "ship to 200 stores by Court order", "ship to 5 regions via Plaza partners", "ship to: 12"):
        assert kinds(text, "POSTAL_ADDRESS") == [], text


def test_the_preview_masks_them_with_the_node_labels():
    text = "?name=Jane+Doe&address=1+Example+Street&x=1"
    assert R.mask_pii_preview(text) == "?name=[REDACTED_PERSON_NAME]&address=[REDACTED_POSTAL_ADDRESS]&x=1"


def test_keyed_finders_are_linear():
    from ._timing import assert_linear

    builders = {
        "ship to spaces": lambda k: "ship to " + " " * (4 * k),
        "ship to words": lambda k: "ship to 1 " + "a " * k,
        "full_name spaces": lambda k: "full_name" + " " * (4 * k),
        "quoted full_name": lambda k: '"full_name"' + " " * (2 * k) + ":",
        "cjk label": lambda k: "姓名：" + "山" * (4 * k),
        "cjk labels": lambda k: "姓名" * (2 * k),
        "street words": lambda k: "street: " + "1 " * (2 * k),
        "ship to lines": lambda k: "ship to 1 Main Street " * (k // 5),
        "header runs": lambda k: "X-abcd" + " " * (4 * k),
        "name keys": lambda k: "name=" * k,
    }
    for label, build in builders.items():
        assert_linear(R.find_pii_spans, build, 40000, label)
