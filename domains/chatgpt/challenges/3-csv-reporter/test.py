#!/usr/bin/env python3
"""Test suite for CSV reporter challenge.
Run: python test.py
All 5 tests must pass.
"""
import subprocess
import sys

passed = 0
failed = 0


def assert_test(condition, name, detail=""):
    global passed, failed
    if condition:
        print(f"PASS: {name}")
        passed += 1
    else:
        print(f"FAIL: {name}{' — ' + detail if detail else ''}")
        failed += 1


# Run the solution
try:
    result = subprocess.run(
        [sys.executable, "report.py"],
        capture_output=True, text=True, timeout=10
    )
    output = result.stdout
    if result.returncode != 0:
        print(f"FAIL: report.py exited with code {result.returncode}")
        print(f"stderr: {result.stderr}")
        sys.exit(1)
except FileNotFoundError:
    print("FAIL: report.py not found")
    sys.exit(1)

# Test 1: Total Revenue = $22015.00
assert_test(
    "$22015.00" in output or "$22,015.00" in output,
    "Total Revenue is $22015.00",
    f"got: {[l for l in output.split(chr(10)) if 'total' in l.lower() or 'revenue' in l.lower()]}"
)

# Test 2: Top 3 products by units - Widget A (275), Widget B (126), Widget C (75)
has_a = "Widget A" in output and "275" in output
has_b = "Widget B" in output and "126" in output
has_c = "Widget C" in output and "75" in output
assert_test(
    has_a and has_b and has_c,
    "Top 3 products correct (Widget A: 275, Widget B: 126, Widget C: 75)",
    f"A={has_a}, B={has_b}, C={has_c}"
)

# Test 3: Revenue by region - North $9355, East $4290, South $4240, West $4130
has_north = "North" in output and "9355" in output
has_east = "East" in output and "4290" in output
has_south = "South" in output and "4240" in output
has_west = "West" in output and "4130" in output
assert_test(
    has_north and has_east and has_south and has_west,
    "Revenue by region correct",
    f"North={has_north}, East={has_east}, South={has_south}, West={has_west}"
)

# Test 4: Highest revenue month is 2024-05 ($4315.00)
assert_test(
    "2024-05" in output and "4315" in output,
    "Highest revenue month is 2024-05 ($4315.00)",
    f"looking for '2024-05' and '4315' in output"
)

# Test 5: Highest avg order value is Widget D ($585.00)
assert_test(
    "Widget D" in output and "585" in output,
    "Highest avg order value is Widget D ($585.00)",
    f"looking for 'Widget D' and '585' in output"
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed > 0 else 0)
