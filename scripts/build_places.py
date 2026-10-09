"""Generate the first draft of data/places.json.

Run once to create the draft. After that, data/places.json is the source of truth and is edited by hand
or with the in-browser tagging tool (index.html?edit). Re-running refuses to overwrite unless --force.

Sources for names and facts: IITG website (iitg.ac.in) and the IITG Freshers Portal (iitg.ac.in/freshers),
read October 2026. Descriptions are written fresh, not copied. Positions come from OpenStreetMap where a
named feature exists; everything else is marked needs_location.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "places.json"
FRESHERS = "https://iitg.ac.in/freshers"
ACAD = "https://iitg.ac.in/iitg_academic?aca="

# (id, name, category, osm_id or None, description, extra)
# category: academic | hostel | food | facility | services | sports | admin | gate | nature | residential
P = []


def add(id, name, cat, osm=None, desc="", **extra):
    P.append(dict(id=id, name=name, category=cat, osm=osm, description=desc, **extra))


# ---------- Academic ----------
add("academic-complex", "Academic Complex", "academic", "way/121451174",
    "The academic heart of campus: a long chain of connected 'Core' blocks housing most departments, labs and faculty offices.")
add("core-5", "Core 5", "academic", "way/912248054", "One of the Core blocks of the Academic Complex.")
add("lecture-halls", "Lecture Halls", "academic", "way/684576024",
    "Large lecture theatres where most first-year courses are taught.", aliases=["LH", "Lecture Theatres"])
add("library", "Lakshminath Bezbaroa Central Library", "academic", None,
    "Four-storey central library, open 8 AM–2 AM and round the clock in exam weeks. Self-service RFID kiosks for issue and return.",
    aliases=["LNBC Library", "Central Library"], url="https://www.iitg.ac.in/lib/", hours="08:00–02:00 (24×7 during exams)")
add("ccc", "Computer & Communication Centre", "academic", "node/4584953590",
    "Runs campus internet, Wi-Fi, email and the phone network; open lab with 450+ machines.",
    aliases=["CCC", "Computer Centre"], url="https://www.iitg.ac.in/cc/", hours="08:00–00:00")
add("cet", "Centre for Educational Technology", "academic", "node/12948811601", "", url="https://www.iitg.ac.in/cet/")
add("workshop", "Mechanical Workshop", "academic", "way/517935377", "Central workshop for hands-on manufacturing labs.")
add("auditorium", "Bhupen Hazarika Auditorium", "academic", "way/144431212",
    "Main auditorium for convocations, talks and cultural nights. Named after the legendary Assamese musician.")
add("conference-hall", "Conference Hall", "academic", "way/684576023", "")
add("cif", "Central Instruments Facility", "academic", None, "Shared high-end research instruments.", url="https://www.iitg.ac.in/cif")
add("tic", "Technology Incubation Centre", "academic", None, "Home for startups incubated at IITG.", url="https://tic.iitg.ac.in/")
add("research-park", "IITG Research Park", "academic", None, "", url="https://respark.iitg.ac.in/",
    hint="Adjacent to campus, possibly just outside the boundary")
add("ccd-career", "Centre for Career Development", "academic", None, "Placements and internships office.",
    aliases=["CCD (placements)"], url="http://www.iitg.ac.in/ccd/")
add("centre-creativity", "Centre for Creativity", "academic", None, "", url="https://www.iitg.ac.in/ccr/")

depts = [
    ("bsbe", "Biosciences & Bioengineering", "BSBE", 2002),
    ("che", "Chemical Engineering", "CL", 2002),
    ("chem", "Chemistry", "CH", 1995),
    ("ce", "Civil Engineering", "CE", 1997),
    ("cse", "Computer Science & Engineering", "CSE", 1995),
    ("design", "Design", "DoD", None),
    ("eee", "Electronics & Electrical Engineering", "EEE", 1995),
    ("hss", "Humanities & Social Sciences", "HSS", None),
    ("math", "Mathematics", "MA", None),
    ("me", "Mechanical Engineering", "ME", None),
    ("phy", "Physics", "PH", None),
]
for id, name, short, year in depts:
    add(f"dept-{id}", f"Department of {name}", "academic", None, "", short=short, subcategory="department",
        **({"established": year} if year else {}), hint="Inside the Academic Complex — which Core block / floor?")

schools = [
    ("sart", "School of Agro and Rural Technology", "school-of-agro-and-rural-technology"),
    ("sob", "School of Business", "school-of-business"),
    ("siss", "School of Interdisciplinary Studies and Sustainability", "school-of-interdisciplinary-studies-and-sustainability"),
    ("msdsai", "Mehta Family School of Data Science & AI", "mehta-family-school-of-data-science-and-artificial-intelligence"),
    ("sese", "School of Energy Science and Engineering", "school-of-energy-sciences-and-engineering"),
    ("shst", "Jyoti & Bhupat Mehta School of Health Sciences & Technology", "school-of-health-science-and-technology"),
]
for id, name, slug in schools:
    add(f"school-{id}", name, "academic", None, "", subcategory="school", url=ACAD + slug)

centres = [
    ("iks", "Centre for Indian Knowledge Systems", "centre-for-indian-knowledge-system"),
    ("clst", "Centre for Linguistic Science and Technology", "centre-for-linguistic-science-and-technology"),
    ("manekshaw", "Manekshaw Centre of Excellence for National Security Studies", "manekshaw-centre-of-excellence-for-national-security-studies-and-research"),
    ("nano", "Centre for Nanotechnology", "centre-for-nanotechnology"),
]
for id, name, slug in centres:
    add(f"centre-{id}", name, "academic", None, "", subcategory="centre", url=ACAD + slug,
        **({"hint": "Opposite Core 5 (new building, opened Nov 2021)"} if id == "nano" else {}))

# ---------- Hostels (facts from the Freshers Portal hostel list) ----------
hostels = [
    ("manas", "Manas", "way/121455439", 1995, "Boys", 300, "One of the oldest boys' hostels, with a leafy courtyard and a long alumni legacy."),
    ("dihing", "Dihing", "way/121455426", 2000, "Boys", 500, "Next door to Brahmaputra; famous for its own football league."),
    ("kapili", "Kapili", "way/121455436", 2003, "Boys", 300, "A mostly-undergrad hostel with its own juice centre and music room."),
    ("siang", "Siang", "way/121455432", 2003, "Boys", 300, "UG-only hostel tucked beside a green hill and a small lake — great sunsets."),
    ("subansiri", "Subansiri", "way/121455433", 2003, "Girls", 500, "The first girls' hostel on campus, home to UG, PG and research students."),
    ("kameng", "Kameng", "way/121455427", 2005, "Boys", 504, "Five blocks, four in-hostel grounds and a much-loved canteen."),
    ("umiam", "Umiam", "way/121455441", 2008, "Boys", 430, "Mixes UG, PG and PhD residents under one roof."),
    ("barak", "Barak", "way/405811283", 2011, "Boys", 430, "Four-time General Championship winners."),
    ("brahmaputra", "Brahmaputra", "way/368852086", 2011, "Boys", 1000, "The biggest hostel on campus, home to nearly a thousand students."),
    ("dhansiri", "Dhansiri", "way/912248050", 2014, "Girls", 230, "White building beside the sports field, a short walk from the New SAC and the hospital."),
    ("lohit", "Lohit", "way/640770642", 2014, "Boys", 800, "Big canteen, a huge terrace and four in-hostel grounds."),
    ("msh", "Married Scholars Hostel", "way/1236294853", 2012, "Married scholars", 170, "Family housing for married PhD and Master's students, with play areas and lawns."),
    ("disang", "Disang", "way/912248048", 2019, "Girls", 1000, "Large, modern hostel for 1000+ residents with its own gym and juice centre."),
    ("gaurang", "Gaurang", "way/1336870219", 2024, "Boys", 500, "The newest hostel, right in front of Kameng."),
    ("dibang", "Dibang", "way/455100471", None, None, None, ""),
]
for id, name, osm, year, gender, cap, desc in hostels:
    facts = {k: v for k, v in (("established", year), ("residents", gender), ("capacity", cap)) if v}
    add(f"hostel-{id}", name if "Hostel" in name else f"{name} Hostel", "hostel", osm, desc,
        url=f"{FRESHERS}/hostel-list", **facts)

# ---------- Facilities ----------
add("hospital", "IITG Hospital", "facility", "way/684576018",
    "24×7 campus hospital with emergency room, pharmacy, visiting specialists and two ambulances.",
    url="https://www.iitg.ac.in/medical/", hours="24×7")
add("guest-house", "Guest House", "facility", "way/121451145", "Rooms for visitors and guests of the institute.",
    url="https://www.iitg.ac.in/aer/index_page_details.php?page=0009&title=guest-house-booking")
add("guest-house-new", "New Guest House", "facility", "way/684576019", "", hint="Is this the new guest house?")
add("sac", "Student Activity Centre (Old SAC)", "sports", "way/158011014",
    "Indoor sports — badminton, TT, squash, chess, weightlifting — plus an ATM close to the hostels.", aliases=["SAC"])
add("new-sac", "New Student Activity Centre", "sports", "way/267002635", "Clubs, gyms and student activities.", aliases=["New SAC"])
add("gym", "Central Gym", "sports", "way/640776537", "Open to all; there is also a separate women's gym in SAC.")
add("pool", "Swimming Pool", "sports", None, "8-lane, 50 m pool. Needs a separate registration and pool card.")
add("sports-field", "SAC Grounds", "sports", "way/144431213",
    "Floodlit fields for football, hockey, volleyball and more, open till 9 PM. Borrow kit at the SAC desk with your ID.")
add("cricket-ground", "Cricket Ground", "sports", "way/1434855471", "")

# ---------- Food ----------
add("food-court", "Food Court", "food", "way/363651727",
    "The go-to hangout: Subway, Baskin Robbins, Fat Belly, Urban Tadka, Big Byte Bakery and more under one roof.")
add("kfc", "KFC", "food", None, "Red container kiosk with open-air seating.", hint="Near Brahmaputra and Dihing hostels")
add("dominos", "Domino's", "food", None, "Blue container outlet with red umbrellas and open-air seating.")
add("ccd-cafe", "Café Coffee Day", "food", "node/4715488480", "Coffee stop near the academic area.")
add("lh-canteen", "Lecture Hall Canteen", "food", "node/4715488481", "Quick bites between classes.")
add("tapri", "Tapri", "food", "node/11475714404", "Chai and snacks.")
add("khokha", "Khokha Market", "food", None,
    "Cheap, tasty local food plus cycle repair, courier and salons — a campus institution.", hint="Near the Faculty Gate")

# ---------- Services ----------
add("market-complex", "Market Complex", "services", "way/121455959",
    "Groceries, pharmacy, salon, computer repair, a restaurant and an ICICI Bank branch with ATM.",
    aliases=["Shopping Complex"], hint="Near the Main Gate")
add("sbi", "State Bank of India", "services", "node/6414070195", "Branch and ATM near the Academic Complex.")
add("canara", "Canara Bank", "services", "node/6414070196", "Branch and ATM near the Academic Complex.")
add("post-office", "Post Office & Railway Reservation", "services", None,
    "Send parcels and book train tickets without leaving campus.", hint="Near the KV Gate")
add("cycle-repair", "Cycle Repair Shop", "services", "node/11475714403", "")

# ---------- Admin ----------
add("admin", "Administrative Building", "admin", "way/121451183", "Director's office, registrar and most admin sections.")
add("pms", "Planning and Management Section", "admin", "way/912248052", "")

# ---------- Gates & transport ----------
for id, name in (("main-gate", "Main Gate"), ("faculty-gate", "Faculty Gate"), ("kv-gate", "KV Gate")):
    add(id, name, "gate", None, "")
add("bus-stop", "City Bus Stop", "gate", "node/4701291692", "Institute buses to and from Guwahati city.",
    hint="Check: OSM calls this 'IIT to PB firststop'")

# ---------- Schools & residential ----------
add("kv", "Kendriya Vidyalaya IIT Guwahati", "residential", None, "")
add("akshara", "Akshara Pre-Primary School", "residential", None, "", url="http://www.iitg.ac.in/akshara")
add("transit-complex", "Transit Complex", "residential", "way/121451168", "")
for t in "ABCDEF":
    add(f"quarters-{t.lower()}", f"{t}-Type Quarters", "residential", None, "Faculty and staff housing.")

# ---------- Nature ----------
add("lake", "IITG Lake", "nature", "way/144431215", "")
add("lake-gh", "Guest House Lake", "nature", "way/144431216", "")
add("serpentine", "Serpentine Lake", "nature", "relation/2336605", "A long winding lake in the north of campus.")
add("childrens-park", "Children's Park", "nature", "way/684566615", "")
add("brahmaputra-view", "Brahmaputra Riverfront", "nature", None, "Sunset point along the river on the southern edge of campus.")


def centroid(geom):
    t = geom["type"]
    if t == "Point":
        return geom["coordinates"]
    ring = {"Polygon": lambda c: c[0], "MultiPolygon": lambda c: c[0][0], "LineString": lambda c: c}[t](geom["coordinates"])
    xs, ys = zip(*ring)
    return [round(sum(xs) / len(xs), 6), round(sum(ys) / len(ys), 6)]


def main():
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT} exists — it is hand-edited now. Use --force to regenerate (loses edits).")
    feats = {}
    for f in (ROOT / "data/osm").glob("*.geojson"):
        for ft in json.loads(f.read_text(encoding="utf-8"))["features"]:
            feats[ft["id"]] = ft
    out = []
    for p in P:
        f = feats.get(p["osm"]) if p["osm"] else None
        p["lnglat"] = centroid(f["geometry"]) if f else None
        p["status"] = "from_osm" if f else "needs_location"
        p["feature"] = p.pop("osm") if f else None
        out.append({k: v for k, v in p.items() if v not in ("", None) or k in ("lnglat", "status")})
    OUT.write_text(json.dumps({"version": 1, "places": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    n = sum(p["status"] == "from_osm" for p in out)
    print(f"{len(out)} places, {n} located from OSM, {len(out) - n} need a location -> {OUT}")


if __name__ == "__main__":
    main()
