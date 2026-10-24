import { describe, expect, it } from "vitest";
import type { Paper } from "../../api";
import { authorList, paperIds, paperSource, progressOf } from "./paper-meta";

describe("paperIds", () => {
  it("reads arXiv ids and the year", () => {
    expect(paperIds("arxiv:2301.12345v2")).toEqual({
      arxiv: "2301.12345",
      doi: "",
      year: 2023,
    });
  });
  it("reads a DOI", () => {
    expect(paperIds("10.1145/3292500.3330701").doi).toBe(
      "10.1145/3292500.3330701",
    );
  });
  it("knows nothing from nothing", () => {
    expect(paperIds("")).toEqual({ arxiv: "", doi: "", year: 0 });
  });
});

describe("paperSource", () => {
  const paper = { external_id: "arxiv:1706.03762" } as Paper;
  it("prefers a known venue and falls back to the identifier's source", () => {
    expect(
      paperSource(paper, { paper_id: "p", status: "ok", venue: "NeurIPS" }),
    ).toBe("NeurIPS");
    expect(paperSource(paper)).toBe("arXiv");
    expect(
      paperSource(paper, {
        paper_id: "p",
        status: "missing",
        venue: "NeurIPS",
      }),
    ).toBe("arXiv");
    expect(
      paperSource({ external_id: "10.1145/3292500.3330701" } as Paper),
    ).toBe("DOI");
    expect(paperSource({ external_id: "" } as Paper)).toBe("");
  });

  it.each([
    ["neural information processing systems", "NeurIPS"],
    ["Advances in Neural Information Processing Systems", "NeurIPS"],
    ["nips", "NeurIPS"],
    ["International Conference on Machine Learning", "ICML"],
    ["international conference on learning representations", "ICLR"],
    ["annual meeting of the association for computational linguistics", "ACL"],
    ["conference on empirical methods in natural language processing", "EMNLP"],
    [
      "North American Chapter of the Association for Computational Linguistics",
      "NAACL",
    ],
    ["AAAI Conference on Artificial Intelligence", "AAAI"],
    ["IEEE/CVF Conference on Computer Vision and Pattern Recognition", "CVPR"],
    ["IEEE International Conference on Computer Vision", "ICCV"],
    ["European Conference on Computer Vision", "ECCV"],
    [
      "ACM SIGKDD International Conference on Knowledge Discovery and Data Mining",
      "KDD",
    ],
    ["The Web Conference", "WWW"],
    [
      "International ACM SIGIR Conference on Research and Development in Information Retrieval",
      "SIGIR",
    ],
    ["CHI Conference on Human Factors in Computing Systems", "CHI"],
    ["ACM Symposium on User Interface Software and Technology", "UIST"],
    [
      "  conference on empirical methods\n in natural language processing  ",
      "EMNLP",
    ],
    ...[
      "NeurIPS",
      "ICML",
      "ICLR",
      "ACL",
      "EMNLP",
      "NAACL",
      "AAAI",
      "CVPR",
      "ICCV",
      "ECCV",
      "KDD",
      "WWW",
      "SIGIR",
      "CHI",
      "UIST",
    ].map((venue) => [venue.toLowerCase(), venue]),
  ])("displays %s as %s without changing the record", (venue, label) => {
    const meta = { paper_id: "p", status: "ok", venue } as const;
    expect(paperSource(paper, meta)).toBe(label);
    expect(meta.venue).toBe(venue);
  });

  it.each([
    ["eLife", "eLife"],
    [
      "IEEE Transactions on Pattern Analysis and Machine Intelligence",
      "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    ],
    [
      "Journal of Machine Learning Research",
      "Journal of Machine Learning Research",
    ],
    [
      "journal of machine learning research",
      "Journal Of Machine Learning Research",
    ],
    ["études scientifiques", "Études Scientifiques"],
    ["计算机学报", "计算机学报"],
    [
      "international conference on machine learning workshops",
      "International Conference On Machine Learning Workshops",
    ],
    ["   ", "arXiv"],
  ])("keeps source case or title-cases unknown venue %s", (venue, label) => {
    expect(paperSource(paper, { paper_id: "p", status: "ok", venue })).toBe(
      label,
    );
  });
});

describe("authorList / progressOf", () => {
  it("splits names", () => {
    expect(authorList("A B, C D and E F")).toEqual(["A B", "C D", "E F"]);
  });
  it("clamps progress", () => {
    expect(progressOf(5, 10)).toBe(0.5);
    expect(progressOf(null, 10)).toBe(0);
    expect(progressOf(20, 10)).toBe(1);
  });
});
