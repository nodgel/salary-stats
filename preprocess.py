#!/usr/bin/env python3
"""Build a compact JS data file from the rs.ge salary CSVs."""
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path("/Users/nodargelovani/Downloads/salary stats")
OUT = Path(__file__).parent / "data.js"

CANONICAL_RANGES = [
    (0, 100), (100, 200), (200, 300), (300, 400), (400, 500),
    (500, 600), (600, 700), (700, 800), (800, 900), (900, 1000),
    (1000, 1100), (1100, 1200), (1200, 2400), (2400, 3600),
    (3600, 4800), (4800, 6000), (6000, 7200), (7200, 9600),
    (9600, 12000), (12000, 15000), (15000, 20000), (20000, 25000),
    (25000, 30000), (30000, 40000), (40000, 50000), (50000, 60000),
    (60000, 70000), (70000, 80000), (80000, 90000), (90000, 100000),
    (100000, None),
]
RANGE_INDEX = {(lo, hi): i for i, (lo, hi) in enumerate(CANONICAL_RANGES)}

TYPE_MAP_EN = {
    "ყველა (All)": "All",
    "ხელფასი (Salary)": "Salary",
    "მოგება (Profit)": "Profit",
    "დივიდენდი (Dividend)": "Dividend",
    "პროცენტი (Interest)": "Interest",
    "როიალტი (Royalty)": "Royalty",
    "სტიპენდია (Stipend)": "Stipend",
    "მომსახურების ანაზღაურება (Service Fee)": "Service Fee",
    "იჯარის მომსახურების ანაზღაურება (Lease Service Fee)": "Lease Fee",
    "ნივთმოგება (Property Income)": "Property",
    "ამხანაგობის დასაბეგრი მოგების წილი (Partnership Profit Share)": "Partnership",
    "სოციალური გადასახადით დაბეგვრადი ანაზღაურება (Social Tax Compensation)": "Social Tax",
    "სხვა (Other)": "Other",
}


def parse_range(label: str):
    nums = [int(n) for n in re.findall(r"\d+", label.replace(" ", ""))]
    if len(nums) == 1:
        return (nums[0], None)
    return (nums[0], nums[1])


def parse_money(s: str) -> float:
    s = s.replace(",", "").replace(" ", "").strip()
    if not s or "#" in s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


# Aggregate: key=(year, month, type) -> bucket_index -> [count, income]
agg = defaultdict(lambda: [[0, 0.0] for _ in CANONICAL_RANGES])

for fname in ["rs_ge_statistics_salary_and_all_types.csv", "rs_ge_statistics_by_year_month_type.csv"]:
    path = DATA_DIR / fname
    with path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            year = int(row["Year"])
            month = row["Month"].strip().strip('"')
            typ_raw = row["Type"].strip().strip('"')
            typ = TYPE_MAP_EN.get(typ_raw, typ_raw)
            rng = parse_range(row["Income Range"])
            if rng not in RANGE_INDEX:
                continue
            idx = RANGE_INDEX[rng]
            count = int(parse_money(row["Number of Individuals"]))
            income = parse_money(row["Taxable Income (GEL)"])
            slot = agg[(year, month, typ)][idx]
            slot[0] += count
            slot[1] += income

# Build records: only emit non-empty ones
records = []
for (year, month, typ), buckets in agg.items():
    total_count = sum(b[0] for b in buckets)
    if total_count == 0:
        continue
    records.append({
        "y": year,
        "m": month,
        "t": typ,
        "b": [[b[0], round(b[1], 2)] for b in buckets],
    })

# Sort for deterministic output
month_order = ["All", "January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
records.sort(key=lambda r: (r["y"], month_order.index(r["m"]) if r["m"] in month_order else 99, r["t"]))

ranges = [{"lo": lo, "hi": hi} for (lo, hi) in CANONICAL_RANGES]

# Get distinct values for UI
years = sorted({r["y"] for r in records})
months = [m for m in month_order if any(r["m"] == m for r in records)]
types = sorted({r["t"] for r in records})

payload = {
    "ranges": ranges,
    "years": years,
    "months": months,
    "types": types,
    "records": records,
}

js = "// Auto-generated. Do not edit by hand.\nwindow.SALARY_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
OUT.write_text(js, encoding="utf-8")

print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")
print(f"Records: {len(records):,}  Years: {len(years)}  Months: {len(months)}  Types: {len(types)}")
print(f"Types: {types}")
