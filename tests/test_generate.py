"""Public tests of the data rules in generate.py, on small made-up fixtures. No network, no snapshot."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import generate as g  # noqa: E402


def test_role_rule_drops_copies_and_tails():
    assert g.role_key("Copy of Customer Service Delivery Advocate") == "customer service delivery advocate"
    assert g.role_key("Customer Service Delivery Advocate- 4 day work week!") == "customer service delivery advocate"
    assert g.role_key("Vehicle Delivery Driver - 4 Day Work Week!") == "vehicle delivery driver"
    assert g.role_key("Class A Hazmat Driver | Benefits Day 1 | Home Daily") == "class a hazmat driver"
    assert g.role_key("Lot Driver I (Part Time)") == "lot driver i"


def test_role_rule_keeps_the_part_with_a_delivery_word():
    assert g.role_key("General Manager - Delivery Operations") == "delivery operations"


def test_seasonal_rule_ignores_benefits_lines_and_non_seasonal():
    assert g.seasonal("Delivery Driver", "Generous PTO + paid holidays. Holiday and Paid Time Off.") is None
    assert g.seasonal("Box Truck Driver", "We are a non-seasonal and stable business.") is None
    assert g.seasonal("Seasonal Delivery Driver", "") == "title"
    assert g.seasonal("Delivery Driver", "This is a seasonal position through January.").startswith("text")
    assert g.seasonal("Non-Seasonal Driver", "") is None


def test_clustered_needs_a_full_board():
    assert g.clustered([1])[0] is False
    assert g.clustered([1, 2])[0] is False
    assert g.clustered([1] * 19)[0] is False
    assert g.clustered([1] * 20)[0] is True
    assert g.clustered([1] * 16 + [200] * 4)[0] is True
    assert g.clustered([1] * 15 + [200] * 5)[0] is False
    assert g.clustered(list(range(0, 15)) + [100] * 5)[0] is False  # 15 of 20 inside 14 days is three in four, under four in five


def test_name_check_whole_word_apostrophes_and_short_names():
    assert g.names_company("Join the Mom’s Meals team", ["Mom's Meals"])
    assert not g.names_company("Join our roster of drivers", ["Ro"])
    assert g.names_company("At Ro, we", ["Ro"])
    assert not g.names_company("At ro, we", ["Ro"])
    assert g.names_company("Sila Heating, Cooling, Plumbing", ["Sila Services", "Sila"])
    assert not g.names_company("Silas Marner", ["Sila"])


def test_region_rule():
    assert g.region("Austin, TX") == "US"
    assert g.region("Moonachie, New Jersey, United States") == "US"
    assert g.region("Paris, Paris, France") == "not US"
    assert g.region("Hayward") == "place not readable"
    assert g.region("anything", "US") == "US"
    assert g.region("anything", "CA") == "not US"


def test_number_lines_splits_sentences_and_caps():
    lines, cut = g.number_lines("First line. Second one!\nThird")
    assert lines == ["First line.", "Second one!", "Third"]
    assert cut is False
    lines, cut = g.number_lines("\n".join(f"Line {i}." for i in range(300)))
    assert len(lines) == 200 and cut is True


def test_version_2_title_words_include_logistics_transportation_routing_and_field_technicians():
    for title in ["Logistics Manager", "National Transportation Manager", "Routing Analyst", "Route Sales Driver",
                  "Field Technician - Louisville, KY", "Field Service Technician (Appliance Repair)", "Delivery Driver"]:
        assert g.TITLE.search(title), title
    for title in ["Fieldwork Coordinator", "Senior Accountant", "Transport Engineer"]:
        assert not g.TITLE.search(title), title


def test_a_leadership_title_counts_as_new_for_60_days_others_for_30():
    assert g.is_new_role("Director of Home Delivery", 43)
    assert g.is_new_role("Logistics Manager", 60)
    assert not g.is_new_role("Logistics Manager", 61)
    assert not g.is_new_role("Delivery Driver", 43)
    assert g.is_new_role("Delivery Driver", 30)
    assert not g.is_new_role("Director of Home Delivery", 5, can_be_new=False)


def test_region_reads_us_states_first_and_more_countries():
    assert g.region("Dublin, OH") == "US"
    assert g.region("Albuquerque, New Mexico") == "US"
    assert g.region("Melbourne, FL") == "US"
    assert g.region("Johor Bahru, Johor, Malaysia") == "not US"
    assert g.region("Manila, Manila, Philippines") == "not US"
    assert g.region("Paris, France") == "not US"
    assert g.region("Remote") == "place not readable"

