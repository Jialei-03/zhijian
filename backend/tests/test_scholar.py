"""Bibliographic lookup and the stored paper record. Nothing here reaches the network."""

import json

import httpx
import pytest
from sqlalchemy import select

from backend import scholar
from backend.models import Paper
from backend.paper_metadata import PaperMetadata
from backend.tests.test_acceptance import env as env  # noqa: PLC0414
from backend.tests.test_acceptance import paper, write

S2_ATTENTION = {
    "title": "Attention is All you Need",
    "authors": [{"name": "Ashish Vaswani"}, {"name": "Noam Shazeer"}],
    "year": 2017,
    "venue": "Neural Information Processing Systems",
    "publicationVenue": {"name": "Neural Information Processing Systems", "type": "conference"},
    "abstract": "The dominant sequence transduction models...",
    "citationCount": 100000,
    "referenceCount": 41,
    "externalIds": {"ArXiv": "1706.03762", "DOI": "10.5555/3295222.3295349"},
    "url": "https://www.semanticscholar.org/paper/abc",
    "publicationTypes": ["Conference"],
    "journal": {"pages": "5998-6008"},
}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """No real request can leave: the transport raises unless a test installs a fake."""
    scholar.clear_cache()
    monkeypatch.setattr(scholar, "MIN_GAP", {})

    def blocked(*args, **kwargs):
        raise AssertionError("a test reached for the network")

    monkeypatch.setattr(httpx.Client, "stream", blocked)
    yield
    scholar.clear_cache()


def fake(monkeypatch, routes):
    calls = []

    def get(url, params=None, accept=""):
        calls.append((url, params))
        for fragment, answer in routes.items():
            if fragment in url:
                if isinstance(answer, Exception):
                    raise answer
                return answer
        raise AssertionError("unexpected " + url)

    monkeypatch.setattr(scholar, "_get", get)
    return calls


def test_lookup_reads_semantic_scholar_and_caches(monkeypatch):
    calls = fake(monkeypatch, {"semanticscholar": json.dumps(S2_ATTENTION).encode()})
    found = scholar.lookup(arxiv="arXiv:1706.03762v5")
    assert found["title"] == "Attention is All you Need"
    assert found["authors"] == ["Ashish Vaswani", "Noam Shazeer"]
    assert (found["year"], found["citation_count"], found["reference_count"]) == (2017, 100000, 41)
    assert found["venue"] == "Neural Information Processing Systems"
    assert found["kind"] == "conference"
    assert found["doi"] == "10.5555/3295222.3295349" and found["arxiv"] == "1706.03762"
    for field in ("title", "authors", "year", "venue", "abstract", "citation_count", "reference_count", "doi", "arxiv", "url"):
        assert field in found
    assert "ARXIV:1706.03762" in calls[0][0]
    scholar.lookup(arxiv="1706.03762")
    assert len(calls) == 1


@pytest.mark.parametrize("venue", ["NeurIPS", {"name": "NeurIPS"}, None, []])
def test_semantic_scholar_accepts_venue_names_and_missing_optional_metadata(venue):
    found = scholar._from_s2({
        "title": "A valid recommendation",
        "publicationVenue": venue,
        "venue": "Fallback journal",
        "externalIds": "",
        "journal": "",
        "authors": [{"name": " A. Author "}, {"name": 1}],
    })
    assert found["title"] == "A valid recommendation"
    assert found["venue"] == ("NeurIPS" if venue else "Fallback journal")
    assert found["authors"] == ["A. Author"]
    assert found["doi"] == found["arxiv"] == ""


def test_falls_back_to_openalex_and_arxiv_and_fills_gaps(monkeypatch):
    openalex = {
        "title": "A paper",
        "doi": "https://doi.org/10.1000/xyz",
        "publication_year": 2020,
        "cited_by_count": 7,
        "referenced_works": ["a", "b"],
        "authorships": [{"author": {"display_name": "Jane Roe"}}],
        "primary_location": {"source": {"display_name": "Journal of Tests", "type": "journal"}, "landing_page_url": "https://x.org/p"},
        "abstract_inverted_index": {"Hello": [0], "world": [1]},
        "biblio": {"volume": "3", "issue": "2", "first_page": "10", "last_page": "20"},
    }
    fake(monkeypatch, {"semanticscholar": scholar.ScholarUnavailable("down"), "openalex": json.dumps(openalex).encode()})
    found = scholar.lookup(doi="10.1000/XYZ")
    assert found["source"] == "OpenAlex"
    assert (found["venue"], found["volume"], found["issue"], found["pages"]) == ("Journal of Tests", "3", "2", "10-20")
    assert found["abstract"] == "Hello world" and found["reference_count"] == 2 and found["kind"] == "journal"

    atom = b"""<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
    <id>http://arxiv.org/abs/2301.00001v2</id><title>Some  preprint</title><summary>Short.</summary>
    <published>2023-01-01T00:00:00Z</published><author><name>A B</name></author></entry></feed>"""
    scholar.clear_cache()
    fake(monkeypatch, {"semanticscholar": scholar.ScholarUnavailable("down"), "openalex": scholar.ScholarUnavailable("down"), "arxiv.org/api": atom})
    found = scholar.lookup(arxiv="2301.00001")
    assert (found["title"], found["year"], found["kind"], found["url"]) == ("Some preprint", 2023, "preprint", "https://arxiv.org/abs/2301.00001")


def test_unavailable_is_not_the_same_as_not_found(monkeypatch):
    fake(monkeypatch, {"semanticscholar": scholar.ScholarUnavailable("down"), "openalex": scholar.ScholarUnavailable("down"), "arxiv.org/api": scholar.ScholarUnavailable("down")})
    assert scholar.lookup(arxiv="2301.00001") is None
    with pytest.raises(scholar.ScholarUnavailable):
        scholar.lookup_checked(arxiv="2301.00001")
    fake(monkeypatch, {"semanticscholar": None, "openalex": None, "arxiv.org/api": None})
    assert scholar.lookup_checked(arxiv="2301.00002") is None


def test_title_search_must_match_the_title(monkeypatch):
    wrong = {"data": [{**S2_ATTENTION, "title": "Something completely different"}]}
    fake(monkeypatch, {"semanticscholar": json.dumps(wrong).encode(), "openalex": json.dumps({"results": []}).encode()})
    assert scholar.lookup(title="Attention is all you need") is None
    right = {"data": [S2_ATTENTION]}
    scholar.clear_cache()
    fake(monkeypatch, {"semanticscholar": json.dumps(right).encode()})
    assert scholar.lookup(title="Attention Is All You Need")["year"] == 2017
    assert scholar.lookup(title="short") is None


def test_transport_maps_failures(monkeypatch):
    class Response:
        def __init__(self, status, body=b"{}"):
            self.status_code, self.body = status, body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def iter_bytes(self):
            yield self.body

    answers = iter([Response(404), Response(429), Response(200, b"x" * (scholar.MAX_BYTES + 1)), httpx.ConnectTimeout("t")])

    def stream(self, method, url, params=None):
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(httpx.Client, "stream", stream)
    url = "https://api.openalex.org/works"
    assert scholar._get(url) is None
    for _ in range(3):
        with pytest.raises(scholar.ScholarUnavailable):
            scholar._get(url)


@pytest.mark.parametrize(
    "venue", ["NeurIPS", "neural information processing systems", "eLife"]
)
def test_metadata_routes_store_refresh_and_report_failure(env, venue):
    app, a, b, _ = env
    p = write(a, "/papers", {"title": "Attention Is All You Need", "external_id": "arxiv:1706.03762"}).json()
    seen = []

    def lookup(**ids):
        seen.append(ids)
        return {**scholar._shape(title="T", year=2017, venue=venue, citation_count=5, reference_count=3, kind="conference", source="Semantic Scholar")}

    app.state.scholar_lookup = lookup
    assert a.get(f"/api/v1/papers/{p['id']}/metadata").json()["status"] == "none"
    row = a.post(f"/api/v1/papers/{p['id']}/metadata/refresh", headers={"Idempotency-Key": "k"}).json()
    assert (row["status"], row["venue"], row["citation_count"]) == ("ok", venue, 5)
    with app.state.maker() as d:
        stored = d.scalar(
            select(PaperMetadata).where(PaperMetadata.paper_id == p["id"])
        )
        assert stored.data["venue"] == venue
    assert seen == [{"doi": "", "arxiv": "1706.03762", "title": ""}]
    assert a.get("/api/v1/paper-metadata").json()[p["id"]]["year"] == 2017
    assert b.get("/api/v1/paper-metadata").json() == {}
    assert b.get(f"/api/v1/papers/{p['id']}/metadata").status_code == 404
    assert b.post(f"/api/v1/papers/{p['id']}/metadata/refresh").status_code == 404

    def down(**ids):
        raise scholar.ScholarUnavailable("down")

    app.state.scholar_lookup = down
    failed = a.post(f"/api/v1/papers/{p['id']}/metadata/refresh")
    assert failed.status_code == 503
    assert a.get(f"/api/v1/papers/{p['id']}/metadata").json()["venue"] == venue

    app.state.scholar_lookup = lambda **ids: None
    assert a.post(f"/api/v1/papers/{p['id']}/metadata/refresh").json()["status"] == "missing"
    short = write(a, "/papers", {"title": "x"}).json()
    assert a.post(f"/api/v1/papers/{short['id']}/metadata/refresh").status_code == 422


def test_metadata_goes_with_the_paper_and_is_rate_limited(env):
    app, a, _, _ = env
    p = paper(a, "A reasonably long title")
    app.state.scholar_lookup = lambda **ids: scholar._shape(title="T")
    codes = [a.post(f"/api/v1/papers/{p['id']}/metadata/refresh").status_code for _ in range(14)]
    assert codes[:12] == [200] * 12 and codes[12:] == [429, 429]
    with app.state.maker() as d:
        assert d.scalar(select(PaperMetadata)) is not None
        revision = d.get(Paper, p["id"]).revision
    deleted = a.delete(f"/api/v1/papers/{p['id']}", headers={"If-Match": str(revision), "X-Confirm-Delete": p["id"]})
    assert deleted.status_code == 200, deleted.text
    with app.state.maker() as d:
        assert d.scalar(select(PaperMetadata)) is None


def test_offline_switch_blocks_the_transport(monkeypatch):
    monkeypatch.setenv("SCHOLAR_OFFLINE", "1")
    assert scholar.lookup(doi="10.1000/xyz") is None
    with pytest.raises(scholar.ScholarUnavailable):
        scholar.lookup_checked(doi="10.1000/xyz")
