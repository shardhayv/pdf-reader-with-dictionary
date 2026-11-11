#!/usr/bin/env python3
"""
scripts/download-dictionaries.py — Download and build category-wise global
dictionaries for Gloss from peer-edited Wikipedia Academic Glossaries and
Princeton WordNet 3.1 domain synsets.

Writes 10 category JSON dictionaries into ~/.local/share/gloss/dictionaries/
(symlinked at ~/Dictionaries) and registers them in ~/.config/gloss/preferences.json.
"""

import concurrent.futures
import html as html_mod
import json
import os
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict

USER_AGENT = "GlossDictionaryBuilder/2.3 (https://github.com/shardhayv/pdf-reader-with-dictionary)"
OUT_DIR = os.path.expanduser(os.environ.get("GLOSS_DICT_DIR", "~/.local/share/gloss/dictionaries"))
PREFS_PATH = os.path.expanduser(os.environ.get("GLOSS_PREFS_PATH", "~/.config/gloss/preferences.json"))

CATEGORIES = [
    {
        "id": "01-computer-science-ai",
        "name": "Computer Science, AI & Cybersecurity",
        "wiki_pages": [
            "Glossary_of_computer_science",
            "Glossary_of_artificial_intelligence",
            "Glossary_of_machine_vision",
            "Glossary_of_computer_hardware_terms",
            "Glossary_of_cryptographic_keys",
            "Glossary_of_digital_forensics_terms",
            "Glossary_of_computer_graphics",
            "Glossary_of_Internet-related_terms",
            "Glossary_of_backup_terms",
            "Glossary_of_reconfigurable_computing",
            "Glossary_of_Unified_Modeling_Language_terms",
            "Glossary_of_quantum_computing",
            "Glossary_of_robotics",
        ],
        "wn_topics": {"computer science", "electronics", "telecommunication"},
        "wn_gloss_tags": {"computer science", "computing", "networking", "cryptography", "software"},
        "wn_roots": {
            "computer_science", "software", "computer_program", "algorithm",
            "data_structure", "programming_language", "computer", "computer_circuit",
            "digital_communication", "communications_protocol", "database",
            "operating_system", "computer_network", "cryptography", "cybernetics",
            "artificial_intelligence", "information_theory", "data_processing",
            "memory_device", "peripheral", "logic_gate", "malware", "website",
        },
    },
    {
        "id": "02-philosophy-logic",
        "name": "Philosophy, Logic & Ethics",
        "wiki_pages": [
            "Glossary_of_philosophy",
            "Glossary_of_logic",
            "Glossary_of_Stoicism_terms",
            "Glossary_of_mereology",
            "Glossary_of_Chinese_philosophy",
            "Glossary_of_Hinduism_terms",
            "Glossary_of_quantum_philosophy",
            "Glossary_of_Principia_Mathematica",
            "Glossary_of_rhetorical_terms",
            "List_of_fallacies",
        ],
        "wn_topics": {"philosophy", "logic", "Hinduism", "Buddhism", "religion"},
        "wn_gloss_tags": {"philosophy", "logic", "ethics", "metaphysics", "epistemology", "theology"},
        "wn_roots": {
            "philosophy", "logic", "ethics", "metaphysics", "epistemology",
            "aesthetics", "theology", "philosophical_doctrine", "philosophical_theory",
            "theological_doctrine", "fallacy", "syllogism", "logical_argument",
            "inference", "proposition", "moral_principle", "virtue", "ideology",
            "world_view", "school_of_thought", "axiology", "ontology",
        },
    },
    {
        "id": "03-economics-finance",
        "name": "Economics, Finance & Commerce",
        "wiki_pages": [
            "Glossary_of_economics",
            "Glossary_of_mergers,_acquisitions,_and_takeovers",
            "Glossary_of_stock_market_terms",
            "Glossary_of_US_mortgage_terminology",
            "Glossary_of_construction_cost_estimating",
            "Glossary_of_project_management",
        ],
        "wn_topics": {"economics", "commerce", "finance", "accounting", "insurance", "banking", "enterprise"},
        "wn_gloss_tags": {"economics", "finance", "commerce", "business", "accounting", "banking"},
        "wn_roots": {
            "economics", "finance", "commerce", "commercial_enterprise", "market",
            "monetary_value", "cost", "price", "tax", "taxation", "debt", "loan",
            "financial_security", "security_interest", "investment", "currency",
            "money", "bank", "financial_institution", "trade", "economic_policy",
            "economic_theory", "economic_condition", "economic_process", "income",
            "payment", "asset", "liability", "accounting", "credit", "bond_certificate",
            "stock_certificate", "derivative_instrument", "commodity", "inflation", "tariff",
        },
    },
    {
        "id": "04-politics-law",
        "name": "Politics, Law & Governance",
        "wiki_pages": [
            "Glossary_of_law",
            "Glossary_of_international_relations_terms",
            "Glossary_of_American_politics",
            "Glossary_of_European_Union_concepts,_acronyms,_and_jargon",
            "Glossary_of_anarchism",
            "Glossary_of_policy_debate_terms",
            "Glossary_of_land_law",
            "Glossary_of_patent_law_terms",
            "Glossary_of_French_criminal_law",
            "Glossary_of_Brexit_terms",
            "List_of_political_ideologies",
        ],
        "wn_topics": {"law", "politics", "diplomacy", "terrorism", "crime", "government"},
        "wn_gloss_tags": {"law", "legal", "politics", "government", "diplomacy", "parliamentary"},
        "wn_roots": {
            "politics", "law", "government", "diplomacy", "crime", "legal_document",
            "legal_proceeding", "judicial_proceeding", "statute", "treaty", "court",
            "pleading", "punishment", "legal_right", "civil_right", "political_system",
            "political_orientation", "political_party", "political_unit", "election",
            "vote", "legislation", "public_policy", "sovereignty", "jurisdiction",
            "contract", "tort", "felony", "misdemeanor", "constitution", "parliament",
        },
    },
    {
        "id": "05-history-civilizations",
        "name": "History, Archaeology & Civilizations",
        "wiki_pages": [
            "Glossary_of_history",
            "Glossary_of_archaeology",
            "Glossary_of_the_British_Raj",
            "Glossary_of_the_French_Revolution",
            "Glossary_of_ancient_Roman_culture",
            "Glossary_of_ancient_Egypt_artifacts",
            "Glossary_of_the_Maya_civilisation",
            "Glossary_of_Japanese_history",
            "Glossary_of_Russian_nobility_and_royalty",
            "Glossary_of_the_Weimar_Republic",
            "Glossary_of_Fascist_Italy",
            "Glossary_of_Nazi_Germany",
            "Glossary_of_American_slavery",
            "Glossary_of_vexillology",
        ],
        "wn_topics": {
            "history", "antiquity", "archaeology", "heraldry", "military",
            "Greek mythology", "Roman mythology", "Norse mythology", "Middle Ages",
        },
        "wn_gloss_tags": {"history", "historical", "antiquity", "archaeology", "heraldry", "mythology"},
        "wn_roots": {
            "history", "antiquity", "archaeology", "heraldry", "historical_period",
            "epoch", "era", "war", "battle", "siege", "military_campaign",
            "revolution", "rebellion", "dynasty", "monarchy", "empire", "colony",
            "feudalism", "nobility", "chivalry", "ancient_history", "civilization",
            "antiquities", "fortification", "body_armor", "classical_mythology",
        },
    },
    {
        "id": "06-biology-medicine",
        "name": "Biology, Genetics, Ecology & Medicine",
        "wiki_pages": [
            "Glossary_of_biology",
            "Glossary_of_cellular_and_molecular_biology_(0–L)",
            "Glossary_of_cellular_and_molecular_biology_(M–Z)",
            "Glossary_of_genetics_and_evolutionary_biology",
            "Glossary_of_developmental_biology",
            "Glossary_of_ecology",
            "Glossary_of_invasion_biology_terms",
            "Glossary_of_virology",
            "Glossary_of_mycology",
            "Glossary_of_protistology",
            "Glossary_of_entomology_terms",
            "Glossary_of_lichen_terms",
            "Glossary_of_scientific_naming",
            "Glossary_of_leaf_morphology",
            "Glossary_of_medicine",
            "Glossary_of_neuroscience",
            "Anatomical_terminology",
            "Medical_terminology",
            "Glossary_of_clinical_research",
            "Glossary_of_phytopathology",
        ],
        "wn_topics": {
            "biology", "botany", "zoology", "genetics", "ecology", "medicine",
            "anatomy", "physiology", "pathology", "bacteriology", "immunology",
        },
        "wn_gloss_tags": {
            "biology", "botany", "zoology", "genetics", "ecology", "medicine",
            "anatomy", "physiology", "pathology", "biochemistry", "immunology",
        },
        "wn_roots": {
            "biology", "botany", "zoology", "genetics", "ecology", "medicine",
            "anatomy", "physiology", "pathology", "cell", "organ", "body_part",
            "tissue", "gene", "chromosome", "protein", "enzyme", "hormone",
            "virus", "bacterium", "microorganism", "fungus", "plant_organ",
            "biological_process", "organic_process", "metabolic_process",
            "evolution", "disease", "illness", "syndrome", "medical_disorder", "symptom",
            "therapy", "medical_procedure", "drug", "medicament", "antibiotic",
            "neural_structure", "vascular_structure", "skeletal_structure",
        },
    },
    {
        "id": "07-chemistry-materials",
        "name": "Chemistry, Biochemistry & Materials",
        "wiki_pages": [
            "Glossary_of_chemistry_terms",
            "Glossary_of_chemical_formulae",
            "Glossary_of_fuel_cell_terms",
            "Glossary_of_nanotechnology",
            "Glossary_of_coal_mining_terminology",
        ],
        "wn_topics": {"chemistry", "biochemistry", "mineralogy"},
        "wn_gloss_tags": {"chemistry", "biochemistry", "organic chemistry", "inorganic chemistry", "metallurgy"},
        "wn_roots": {
            "chemistry", "chemical_element", "chemical_compound", "chemical",
            "organic_compound", "inorganic_compound", "acid", "alkali",
            "salt", "oxide", "polymer", "resin", "hydrocarbon", "alcohol",
            "aldehyde", "ketone", "ester", "amine", "amino_acid", "carbohydrate",
            "lipid", "mineral", "alloy", "metallic_element", "solution", "mixture",
            "catalyst", "chemical_process", "chemical_reaction", "chemical_phenomenon",
            "chemical_bond", "free_radical", "ion", "isotope", "crystal", "solvent",
        },
    },
    {
        "id": "08-math-physics-engineering",
        "name": "Mathematics, Physics, Astronomy & Engineering",
        "wiki_pages": [
            "Glossary_of_physics",
            "Glossary_of_elementary_quantum_mechanics",
            "Glossary_of_string_theory",
            "Glossary_of_astronomy",
            "Glossary_of_meteoritics",
            "Glossary_of_meteorology",
            "Glossary_of_geology",
            "Glossary_of_areas_of_mathematics",
            "Glossary_of_mathematical_jargon",
            "Glossary_of_calculus",
            "Glossary_of_linear_algebra",
            "Glossary_of_probability_and_statistics",
            "Glossary_of_set_theory",
            "Glossary_of_graph_theory",
            "Glossary_of_group_theory",
            "Glossary_of_game_theory",
            "Glossary_of_number_theory",
            "Glossary_of_general_topology",
            "Glossary_of_differential_geometry_and_topology",
            "Glossary_of_category_theory",
            "Glossary_of_systems_theory",
            "Glossary_of_tensor_theory",
            "Glossary_of_real_and_complex_analysis",
            "Glossary_of_functional_analysis",
            "Glossary_of_ring_theory",
            "Glossary_of_field_theory",
            "Glossary_of_engineering:_A–L",
            "Glossary_of_engineering:_M–Z",
            "Glossary_of_electrical_and_electronics_engineering",
            "Glossary_of_mechanical_engineering",
            "Glossary_of_civil_engineering",
            "Glossary_of_structural_engineering",
            "Glossary_of_aerospace_engineering",
            "Glossary_of_power_electronics",
        ],
        "wn_topics": {
            "mathematics", "geometry", "statistics", "physics", "astronomy",
            "geology", "meteorology", "architecture", "engineering", "optics",
            "mechanics", "thermodynamics", "electricity",
        },
        "wn_gloss_tags": {
            "mathematics", "geometry", "statistics", "algebra", "calculus",
            "topology", "set theory", "physics", "quantum mechanics", "optics",
            "thermodynamics", "astronomy", "geology", "meteorology", "engineering",
            "electronics", "acoustics", "mechanics",
        },
        "wn_roots": {
            "mathematics", "geometry", "statistics", "physics", "astronomy",
            "geology", "meteorology", "engineering", "mathematical_relation",
            "mathematical_function", "mathematical_statement", "number", "matrix",
            "vector", "polygon", "polyhedron", "curve", "physical_phenomenon",
            "physical_property", "force", "energy", "radiation", "wave",
            "elementary_particle", "subatomic_particle", "atom", "molecule",
            "celestial_body", "star", "planet", "galaxy", "thermodynamics",
            "mechanics", "optics", "acoustics", "electromagnetism",
            "unit_of_measurement", "measuring_instrument", "electrical_device",
            "electronic_device", "semiconductor_device", "theorem", "equation",
        },
    },
    {
        "id": "09-psychology-linguistics-literature",
        "name": "Psychology, Linguistics & Literature",
        "wiki_pages": [
            "Glossary_of_literary_terms",
            "Glossary_of_rhetorical_terms",
            "Glossary_of_sound_laws_in_the_Indo-European_languages",
            "Glossary_of_journalism",
            "Glossary_of_communication_disorders",
            "Glossary_of_psychoanalysis",
            "Glossary_of_psychiatry",
            "Glossary_of_library_and_information_science",
            "List_of_cognitive_biases",
        ],
        "wn_topics": {
            "psychology", "psychoanalysis", "psychiatry", "linguistics",
            "grammar", "literature", "sociology", "anthropology", "phonetics",
        },
        "wn_gloss_tags": {
            "psychology", "psychoanalysis", "psychiatry", "linguistics",
            "grammar", "phonetics", "literature", "rhetoric", "sociology",
            "anthropology",
        },
        "wn_roots": {
            "psychology", "psychoanalysis", "psychiatry", "linguistics",
            "grammar", "literature", "sociology", "anthropology",
            "psychological_state", "cognitive_process", "perception", "memory",
            "emotion", "feeling", "personality_trait", "mental_disorder",
            "linguistic_relation", "linguistic_unit", "part_of_speech",
            "morpheme", "phoneme", "tense", "rhetorical_device",
            "figure_of_speech", "literary_composition", "literary_genre",
            "poetic_form", "verse", "prosody", "syntax", "semantics",
        },
    },
]


def fetch_wiki_html(page, cache_dir):
    cache_file = os.path.join(cache_dir, f"wiki_{urllib.parse.quote(page, safe='')}.html")
    if os.path.exists(cache_file):
        with open(cache_file, "r", encoding="utf-8") as f:
            return f.read()
    url = (
        f"https://en.wikipedia.org/w/api.php?action=parse"
        f"&page={urllib.parse.quote(page)}&prop=text&format=json&redirects=1"
    )
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            html = data.get("parse", {}).get("text", {}).get("*", "")
            if html:
                with open(cache_file, "w", encoding="utf-8") as f:
                    f.write(html)
            return html
    except Exception as e:
        print(f"  [warn] could not fetch {page}: {e}")
        return ""


def clean_fragment(raw_html):
    s = raw_html
    s = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", "", s, flags=re.I)
    s = re.sub(r"<link\b[^>]*>", "", s, flags=re.I)
    s = re.sub(r'<span class="mw-editsection"[\s\S]*?</span>\s*</span>', "", s, flags=re.I)
    s = re.sub(
        r'<sup\b[^>]*class="[^"]*(?:reference|noprint|Template-Fact)[^"]*"[^>]*>[\s\S]*?</sup>',
        "",
        s,
        flags=re.I,
    )
    s = re.sub(r'<div\b[^>]*class="[^"]*hatnote[^"]*"[^>]*>[\s\S]*?</div>', "", s, flags=re.I)
    s = re.sub(r'<p\b[^>]*class="[^"]*glossary-hatnote[^"]*"[^>]*>[\s\S]*?</p>', "", s, flags=re.I)

    def repl_link(m):
        href = m.group(1)
        label = m.group(2)
        target = urllib.parse.unquote(href.split("/wiki/", 1)[-1].split("#")[0]).replace("_", " ")
        if not target or target.startswith(
            ("Special:", "File:", "Help:", "Wikipedia:", "Template:", "Category:", "Portal:")
        ):
            return label
        return f'<a href="entry://{html_mod.escape(target, quote=True)}">{label}</a>'

    s = re.sub(r'<a\b[^>]*href="(/wiki/[^"]+)"[^>]*>(.*?)</a>', repl_link, s, flags=re.I | re.S)
    s = re.sub(r'<a\b(?![^>]*href="entry://)[^>]*>(.*?)</a>', r"\1", s, flags=re.I | re.S)
    s = re.sub(r"</?(?:span|div|dfn|abbr|dd|dt|dl|section|header)\b[^>]*>", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def strip_tags(s):
    return html_mod.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def extract_aliases(word, raw_context=""):
    aliases = set()
    m = re.match(r"^(.+?)\s*\(([^()]{1,40})\)\s*$", word)
    if m:
        main_w, paren = m.group(1).strip(), m.group(2).strip()
        if main_w:
            aliases.add(main_w)
        if paren and not paren.lower().startswith(("also ", "or ", "e.g.", "i.e.", "lit.", "from ")):
            aliases.add(paren)
    for m_also in re.finditer(
        r"(?:Also(?:\s+called|\s+known\s+as)?|Abbreviated(?:\s+as)?|Sometimes(?:\s+called)?)\s+<b>([^<]{1,80})</b>",
        raw_context,
        flags=re.I,
    ):
        cand = strip_tags(m_also.group(1)).strip(" .,;:")
        if cand and cand != word:
            aliases.add(cand)
    for base in list(aliases | {word}):
        if base.lower() != base:
            aliases.add(base.lower())
        if len(base) > 3 and base.islower():
            aliases.add(base.capitalize())
            if not base.endswith("s"):
                aliases.add(base + "s")
    aliases.discard(word)
    return sorted(aliases)[:24]


def parse_wiki_glossary(html):
    entries = {}
    if not html:
        return entries

    # Pattern 1: <dt>...</dt> followed by optional hatnotes and <dd>...</dd> (linear split on <dt)
    for chunk in re.split(r"(?=<dt\b)", html, flags=re.I):
        if not chunk.lower().startswith("<dt"):
            continue
        dt_end = chunk.lower().find("</dt>")
        if dt_end == -1:
            continue
        raw_dt = chunk[:dt_end]
        after_dt = chunk[dt_end + 5 :]
        # Take everything up to the next </dl>
        dl_end = after_dt.lower().find("</dl>")
        if dl_end != -1:
            after_dt = after_dt[:dl_end]

        raw_dt_clean = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", "", raw_dt, flags=re.I)
        term = strip_tags(raw_dt_clean).strip(" :–—-")
        if not term or len(term) > 120 or term.lower() in {
            "contents", "see also", "references", "external links", "notes"
        }:
            continue
        dds = re.findall(r"<dd\b[^>]*>([\s\S]*?)</dd>", after_dt, flags=re.I)
        cleaned_dds = []
        for dd in dds:
            c = clean_fragment(dd)
            if c and len(strip_tags(c)) >= 8:
                cleaned_dds.append(c)
        if not cleaned_dds:
            continue
        defn = "<br>".join(cleaned_dds)
        aliases = extract_aliases(term, after_dt)
        m_paren = re.match(r"^(.+?)\s*\(([^()]{1,25})\)\s*$", term)
        if m_paren and m_paren.group(2).isupper():
            primary = m_paren.group(1).strip()
            aliases = sorted(set(aliases) | {term, m_paren.group(2).strip()})[:24]
            term = primary
        entries[term] = {"word": term, "definition": defn, "aliases": aliases}

    # Pattern 2: <li><b>Term</b>[.:–—-] Definition</li> or <li><a href="/wiki/...">Term</a>[,.:–—-] Definition</li>
    for chunk in re.split(r"<li\b[^>]*>", html, flags=re.I):
        li_end = chunk.lower().find("</li>")
        if li_end == -1:
            continue
        li_body = chunk[:li_end].strip()
        term = ""
        rest = ""
        if li_body.lower().startswith("<b>"):
            b_end = li_body.lower().find("</b>")
            if 0 < b_end <= 240:
                term = strip_tags(li_body[3:b_end]).strip(" .:–—-")
                after_b = li_body[b_end + 4 :].lstrip()
                if after_b and after_b[0] in ".,:–—-":
                    rest = after_b.lstrip(".,:–—- ")
        elif li_body.lower().startswith('<a href="/wiki/'):
            a_end = li_body.lower().find("</a>")
            if 0 < a_end <= 240:
                term = strip_tags(li_body[: a_end + 4]).strip(" .:–—-")
                after_a = li_body[a_end + 4 :].lstrip()
                if after_a and after_a[0] in ".,:–—-":
                    rest = after_a.lstrip(".,:–—- ")
        if not term or not rest:
            continue
        if "<ul" in rest.lower() or "<ol" in rest.lower():
            rest = re.split(r"<[uo]l\b", rest, maxsplit=1, flags=re.I)[0]
        if len(term) > 100 or len(term) < 2 or term in entries:
            continue
        if len(strip_tags(rest)) < 20:
            continue
        defn = clean_fragment(rest)
        if defn:
            entries[term] = {
                "word": term,
                "definition": defn,
                "aliases": extract_aliases(term, rest),
            }

    # Pattern 3: Table rows <tr><td><b>Term</b></td><td>Definition</td></tr>
    for tr in re.findall(r"<tr\b[^>]*>([\s\S]*?)</tr>", html, flags=re.I):
        cells = re.findall(r"<t[dh]\b[^>]*>([\s\S]*?)</t[dh]>", tr, flags=re.I)
        if len(cells) < 2:
            continue
        term = strip_tags(cells[0]).strip(" .:–—-")
        rest = cells[1]
        if not term or len(term) > 80 or len(term) < 3 or term in entries:
            continue
        if any(ch in term for ch in ("\n", "|", "{", "}")) or term.lower() in {
            "name", "term", "bias", "description", "type"
        }:
            continue
        defn = clean_fragment(rest)
        if defn and 20 <= len(strip_tags(defn)) <= 1200:
            entries[term] = {
                "word": term,
                "definition": defn,
                "aliases": extract_aliases(term, rest),
            }

    # Pattern 4: <h3>Term</h3><p>Definition</p>
    for chunk in re.split(r'<div class="mw-heading mw-heading3">', html, flags=re.I)[1:]:
        h3_m = re.search(r"<h3[^>]*>([\s\S]*?)</h3>", chunk, flags=re.I)
        p_m = re.search(r"<p>([\s\S]*?)</p>", chunk, flags=re.I)
        if not h3_m or not p_m:
            continue
        term = strip_tags(h3_m.group(1)).strip(" .:–—-")
        if not term or len(term) <= 1 or len(term) > 100 or term in entries:
            continue
        if term.lower() in {"see also", "references", "notes", "external links", "further reading"}:
            continue
        defn = clean_fragment(p_m.group(1))
        if defn and len(strip_tags(defn)) >= 20:
            entries[term] = {
                "word": term,
                "definition": defn,
                "aliases": extract_aliases(term),
            }

    return entries


def load_wordnet(cache_dir):
    zip_path = os.path.join(cache_dir, "wordnet.zip")
    if not os.path.exists(zip_path):
        print("Downloading Princeton WordNet 3.1...")
        urllib.request.urlretrieve(
            "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip",
            zip_path,
        )
    zf = zipfile.ZipFile(zip_path)

    inflections = defaultdict(set)
    for pos in ["noun", "verb", "adj", "adv"]:
        exc_name = f"wordnet/{pos}.exc"
        if exc_name in zf.namelist():
            for line in zf.read(exc_name).decode("utf-8").splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    infl = parts[0].replace("_", " ")
                    for base in parts[1:]:
                        b = base.replace("_", " ")
                        if infl != b:
                            inflections[b].add(infl)

    synsets = {}
    pos_map = {"n": "n.", "v": "v.", "a": "adj.", "s": "adj.", "r": "adv."}
    for pos_file in ["noun", "verb", "adj", "adv"]:
        for line in zf.read(f"wordnet/data.{pos_file}").decode("utf-8").splitlines():
            if not line or line.startswith("  "):
                continue
            meta_part, gloss_part = line.split(" | ", 1)
            parts = meta_part.split()
            offset = parts[0]
            ss_type = parts[2]
            pos_key = "a" if ss_type == "s" else ss_type
            w_cnt = int(parts[3], 16)
            words = [parts[4 + 2 * i].replace("_", " ") for i in range(w_cnt)]
            idx = 4 + 2 * w_cnt
            p_cnt = int(parts[idx])
            idx += 1
            hypernyms = []
            topics = []
            for _ in range(p_cnt):
                sym, tgt_off, tgt_pos, _ = parts[idx : idx + 4]
                idx += 4
                tgt_key = ("a" if tgt_pos == "s" else tgt_pos, tgt_off)
                if sym in ("@", "@i"):
                    hypernyms.append(tgt_key)
                elif sym == ";c":
                    topics.append(tgt_key)

            gloss_pieces = [p.strip() for p in gloss_part.split(";")]
            defn_pieces = []
            examples = []
            for p in gloss_pieces:
                if p.startswith('"') and p.endswith('"'):
                    examples.append(p.strip('"'))
                else:
                    defn_pieces.append(p)
            defn_text = "; ".join(defn_pieces).strip()

            # Check for leading parenthetical domain tag like "(mathematics)" or "(chemistry)"
            m_tag = re.match(r"^\(([^()]{2,35})\)\s*", defn_text)
            gloss_tag = m_tag.group(1).lower().strip() if m_tag else ""

            key = (pos_key, offset)
            synsets[key] = {
                "key": key,
                "pos": pos_map.get(ss_type, ""),
                "words": words,
                "defn": defn_text,
                "gloss_tag": gloss_tag,
                "example": examples[0] if examples else "",
                "hypernyms": hypernyms,
                "topics": topics,
            }

    return synsets, inflections


def synset_matches_category(ss_key, synsets, cat_topics, cat_gloss_tags, cat_roots, memo):
    state = memo.get(ss_key)
    if state is not None:
        return state
    memo[ss_key] = False
    ss = synsets.get(ss_key)
    if not ss:
        return False

    # 1. Leading parenthetical domain tag in the definition (e.g. "(mathematics)")
    if ss["gloss_tag"] and ss["gloss_tag"] in cat_gloss_tags:
        memo[ss_key] = True
        return True

    # 2. Primary canonical lemma matches unambiguous category root
    primary_lemma = ss["words"][0].lower().replace(" ", "_")
    if primary_lemma in cat_roots:
        memo[ss_key] = True
        return True

    # 3. Topic domain pointer (;c)
    for t_key in ss["topics"]:
        t_ss = synsets.get(t_key)
        if t_ss:
            for tw in t_ss["words"]:
                if tw.lower() in cat_topics or tw.lower().replace(" ", "_") in cat_roots:
                    memo[ss_key] = True
                    return True

    # 4. Hypernym chain
    for h_key in ss["hypernyms"]:
        if synset_matches_category(h_key, synsets, cat_topics, cat_gloss_tags, cat_roots, memo):
            memo[ss_key] = True
            return True

    return False


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cache_dir = os.environ.get("GLOSS_BUILD_CACHE") or tempfile.mkdtemp(prefix="gloss-dict-build-")
    try:
        all_pages = sorted({p for cat in CATEGORIES for p in cat["wiki_pages"]})
        print(f"Fetching {len(all_pages)} Wikipedia academic glossaries...")
        page_html = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            future_to_page = {pool.submit(fetch_wiki_html, p, cache_dir): p for p in all_pages}
            for fut in concurrent.futures.as_completed(future_to_page):
                p = future_to_page[fut]
                page_html[p] = fut.result()

        synsets, inflections = load_wordnet(cache_dir)
        print(f"Loaded {len(synsets):,} WordNet 3.1 synsets.")

        output_paths = []

        for cat in CATEGORIES:
            entries_by_word = {}
            for p in cat["wiki_pages"]:
                parsed = parse_wiki_glossary(page_html.get(p, ""))
                for w, item in parsed.items():
                    if w not in entries_by_word:
                        entries_by_word[w] = item
                    else:
                        if item["definition"] not in entries_by_word[w]["definition"]:
                            entries_by_word[w]["definition"] += f"<hr>{item['definition']}"
                        entries_by_word[w]["aliases"] = sorted(
                            set(entries_by_word[w]["aliases"]) | set(item["aliases"])
                        )[:24]

            wiki_count = len(entries_by_word)

            memo = {}
            wn_senses_by_word = defaultdict(list)
            wn_examples_by_word = {}

            for ss_key, ss in synsets.items():
                if synset_matches_category(
                    ss_key, synsets, cat["wn_topics"], cat["wn_gloss_tags"], cat["wn_roots"], memo
                ):
                    primary_words = ss["words"]
                    for w in primary_words:
                        sense_line = f"<i>{ss['pos']}</i> {html_mod.escape(ss['defn'])}"
                        if len(primary_words) > 1:
                            syns = [sw for sw in primary_words if sw != w][:4]
                            if syns:
                                sense_line += (
                                    f" <small>(syn: {', '.join(html_mod.escape(s) for s in syns)})</small>"
                                )
                        if sense_line not in wn_senses_by_word[w]:
                            wn_senses_by_word[w].append(sense_line)
                        if ss["example"] and w not in wn_examples_by_word:
                            wn_examples_by_word[w] = ss["example"]

            for w, senses in wn_senses_by_word.items():
                senses_capped = senses[:5]
                wn_html = (
                    senses_capped[0]
                    if len(senses_capped) == 1
                    else "<ol>" + "".join(f"<li>{s}</li>" for s in senses_capped) + "</ol>"
                )
                aliases = set(inflections.get(w, set()))
                if w.lower() != w:
                    aliases.add(w.lower())
                if len(w) > 3 and w.islower() and not w.endswith("s") and " " not in w:
                    aliases.add(w + "s")
                aliases.discard(w)

                if w in entries_by_word:
                    entries_by_word[w]["definition"] += f"<p>{wn_html}</p>"
                    entries_by_word[w]["aliases"] = sorted(
                        set(entries_by_word[w]["aliases"]) | aliases
                    )[:24]
                    if not entries_by_word[w].get("example") and w in wn_examples_by_word:
                        entries_by_word[w]["example"] = wn_examples_by_word[w]
                else:
                    entry = {
                        "word": w,
                        "definition": wn_html,
                        "aliases": sorted(aliases)[:24],
                    }
                    if w in wn_examples_by_word:
                        entry["example"] = wn_examples_by_word[w]
                    entries_by_word[w] = entry

            final_entries = sorted(entries_by_word.values(), key=lambda x: x["word"].lower())
            payload = {
                "format": "gloss-glossary",
                "version": 1,
                "scope": "global",
                "name": cat["name"],
                "language": "en",
                "entries": final_entries,
            }
            out_path = os.path.join(OUT_DIR, f"{cat['id']}.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            size_mb = os.path.getsize(out_path) / (1024 * 1024)
            print(
                f"  ✓ {cat['name']:46s}: {len(final_entries):6,d} entries "
                f"({wiki_count:,d} Wiki + {len(final_entries)-wiki_count:,d} WordNet) [{size_mb:.2f} MB]"
            )
            output_paths.append(out_path)

        print("Building General English Master Dictionary (WordNet 3.1)...")
        general_senses = defaultdict(list)
        general_example = {}
        for ss_key, ss in synsets.items():
            for w in ss["words"]:
                if len(w) > 45 or w.count(" ") > 1:
                    continue
                if len(general_senses[w]) < 4:
                    general_senses[w].append(f"<i>{ss['pos']}</i> {html_mod.escape(ss['defn'])}")
                if ss["example"] and w not in general_example:
                    general_example[w] = ss["example"]

        general_entries = []
        for w in sorted(general_senses.keys(), key=lambda s: s.lower()):
            senses = general_senses[w]
            defn = (
                senses[0]
                if len(senses) == 1
                else "<ol>" + "".join(f"<li>{s}</li>" for s in senses) + "</ol>"
            )
            aliases = sorted(inflections.get(w, set()) - {w})[:12]
            item = {"word": w, "definition": defn}
            if aliases:
                item["aliases"] = aliases
            if w in general_example:
                item["example"] = general_example[w]
            general_entries.append(item)

        gen_path = os.path.join(OUT_DIR, "10-general-english-wordnet.json")
        gen_payload = {
            "format": "gloss-glossary",
            "version": 1,
            "scope": "global",
            "name": "General English (WordNet 3.1)",
            "language": "en",
            "entries": general_entries[:120000],
        }
        with open(gen_path, "w", encoding="utf-8") as f:
            json.dump(gen_payload, f, ensure_ascii=False, separators=(",", ":"))
        size_mb = os.path.getsize(gen_path) / (1024 * 1024)
        print(
            f"  ✓ {'General English (WordNet 3.1)':46s}: {len(gen_payload['entries']):6,d} entries [{size_mb:.2f} MB]"
        )
        output_paths.append(gen_path)

        prefs = {}
        if os.path.exists(PREFS_PATH):
            try:
                with open(PREFS_PATH, "r", encoding="utf-8") as f:
                    prefs = json.load(f)
            except Exception:
                prefs = {}
        existing_order = prefs.get("dictionaries", {}).get("order", [])
        existing_enabled = prefs.get("dictionaries", {}).get("enabled", {})

        new_order = list(output_paths)
        for p in existing_order:
            if p not in new_order and os.path.exists(p):
                new_order.append(p)
        new_enabled = dict(existing_enabled)
        for p in output_paths:
            new_enabled[p] = True

        prefs["dictionaries"] = {"order": new_order, "enabled": new_enabled}
        os.makedirs(os.path.dirname(PREFS_PATH), exist_ok=True)
        with open(PREFS_PATH, "w", encoding="utf-8") as f:
            json.dump(prefs, f, indent=2)
        print(f"Registered {len(output_paths)} dictionaries in {PREFS_PATH}")
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
