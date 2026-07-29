"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { analyzeForegroundMasks } from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";
import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import {
  buildBatchTrainingLabel,
  isSupportedBatchImage,
  prepareBatchTrainingFiles,
  runSequentialBatchTraining,
} from "../lib/vth-batch-learning-core.mjs";
import { buildFeedbackPayload } from "../lib/vth-feedback-core.mjs";
import {
  buildLearnedCandidate,
  buildSharedTrainingApiPayload,
  buildTrainingApiPayload,
  chooseRandomDemoCandidate,
  deleteLearnedCandidateSelection,
  deletableLearnedCandidateIds,
  mergeCandidateSets,
} from "../lib/vth-learning-core.mjs";
import {
  createSharingToken,
  fetchAllSharedTrainingCandidates,
  SHARED_TRAINING_CONSENT_VERSION,
  sharedCandidateDeletionStorageKey,
} from "../lib/vth-shared-training-core.mjs";
import {
  buildSharedRelevanceApiPayload,
  SHARED_RELEVANCE_CONSENT_VERSION,
  sharedRelevanceDeletionStorageKey,
} from "../lib/vth-shared-relevance-core.mjs";
import {
  clamp,
  searchCorpus as coreSearchCorpus,
} from "../lib/vth-shape-core.mjs";
import {
  assembleUbuntuPackage,
  assembleWindowsPackage,
} from "../lib/vth-download-core.mjs";

type Candidate = {
  id: string;
  label: string;
  image: string;
  sourceImage?: string;
  profile: number[];
  stateCount: number;
  family: string;
  peakLocations: number[];
  peakWidths: number[];
  valleyHeights: number[];
  valleyLocations: number[];
  valleyDepths: number[];
  valleyPositionRatios: number[];
  peakValleyDistances: number[];
  tailSlopes: number[];
  area: number;
  learned?: boolean;
  learnedAt?: string;
  storage?: string;
  shared?: boolean;
  canDelete?: boolean;
};

type Reranker = {
  version: number;
  featureNames: string[];
  weights: number[];
  intercept: number;
  finalBlend: {
    curve: number;
    model: number;
    retrieval: number;
  };
  scoreCalibration?: {
    reranked: number;
    retrieval: number;
  };
};

type DualEncoder = {
  version: number;
  kind:
    | "vth-dual-curve-linear"
    | "vth-dual-curve-mlp"
    | "vth-dual-image-curve-mlp";
  inputDimensions: number;
  embeddingDimensions: number;
  hiddenDimensions?: number;
  activation?: "tanh";
  queryWeights?: number[][];
  queryIntercept?: number[];
  queryInputMean?: number[];
  queryInputScale?: number[];
  queryHiddenWeights?: number[][];
  queryHiddenIntercept?: number[];
  queryOutputWeights?: number[][];
  queryOutputIntercept?: number[];
  candidateMean: number[];
  candidateComponents: number[][];
  blendWeight: number;
  rerankLimit: number;
  validation?: Record<string, unknown>;
};

type Corpus = {
  version: number;
  yScale: string;
  yFloor: number;
  yCeiling: number;
  candidateCount: number;
  stateCounts: number[];
  imageEncoder?: {
    version: number;
    kind: "canonical-curve-raster-hog";
    dimensions: number;
  };
  reranker?: Reranker;
  dualEncoder?: DualEncoder;
  candidates: Candidate[];
};

type Descriptor = {
  stateCount: number;
  observedStateCount: number;
  regularized: boolean;
  peakLocations: number[];
  peakWidths: number[];
  valleyHeights: number[];
  valleyLocations: number[];
  valleyDepths: number[];
  valleyPositionRatios: number[];
  peakValleyDistances: number[];
  tailSlopes: number[];
  area: number;
};

type Analysis = {
  id: string;
  fileName: string;
  imageUrl: string;
  panelIndex: number;
  panelCount: number;
  detectedPanelCount: number;
  rejectedNonChartCount: number;
  panelSelectionTruncated: boolean;
  maxPanelCount: number;
  panelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  panelConfidence: number;
  panelMode: "rectangle" | "l-axis" | "content";
  profile: number[];
  descriptor: Descriptor;
  axesDetected: boolean;
  processingMs: number;
  curveHypothesisCount: number;
  distributionCount: number;
  selectedDistributionIndex: number;
  irregularityScore: number;
  removedLabelCount: number;
};

type ExpandedImage = {
  src: string;
  alt: string;
  label: string;
};

type ShapeHypothesis = {
  profile: number[];
  descriptor: Descriptor;
};

type SearchResult = Candidate & {
  rank: number;
  score: number;
  modelScore: number | null;
  imageScore: number;
  curveScore: number;
  countScore: number;
  locationScore: number;
  widthScore: number;
  valleyScore: number;
  tailScore: number;
  areaScore: number;
  peakValleyScore: number;
  valleyDepthScore: number;
  peakValleyDistanceScore: number;
  valleyPositionScore: number;
  peakValleyWeight: number;
  dualEncoderScore?: number;
  curveHypothesisIndex: number;
  reasons: string[];
};

type PanelQuery = {
  analysis: Analysis;
  results: SearchResult[];
};

type RelevanceLabel = "similar" | "dissimilar";

type PanelInteraction = {
  feedback: Record<string, RelevanceLabel>;
  queryCode: string;
  feedbackSharingConsent: boolean;
  feedbackSubmissionStatus: string;
  submittedFeedbackReportId: string;
  submittedFeedbackJudgmentCount: number;
};

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const RANDOM_MULTICHART_SAMPLES = [
  {
    url: "/samples/vnand-random-multichart-mixed-01.png",
    fileName: "vnand-random-multichart-mixed-01.png",
    label: "샘플 1",
  },
  {
    url: "/samples/vnand-random-multichart-mixed-02.png",
    fileName: "vnand-random-multichart-mixed-02.png",
    label: "가변 크기",
  },
  {
    url: "/samples/vnand-random-multichart-lowres-03.png",
    fileName: "vnand-random-multichart-lowres-03.png",
    label: "저해상도",
  },
  {
    url: "/samples/vnand-random-multichart-frameless-04.png",
    fileName: "vnand-random-multichart-frameless-04.png",
    label: "경계 없는 Curve",
  },
  {
    url: "/samples/vnand-fhd-dense-30-chart-sample.png",
    fileName: "vnand-fhd-dense-30-chart-sample.png",
    label: "FHD 밀집 30차트",
  },
] as const;
const CONTRIBUTOR_TOKEN_KEY = "vth-shared-contributor-token";
const RELEVANCE_CONTRIBUTOR_TOKEN_KEY =
  "vth-shared-relevance-contributor-token";

function isStandaloneRuntime() {
  return (
    typeof window !== "undefined" &&
    ["127.0.0.1", "localhost"].includes(window.location.hostname)
  );
}

function sharedApiUrl(path: string) {
  return path;
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = 0.9,
) {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
  if (!blob) throw new Error("차트 이미지를 분리하지 못했습니다.");
  return blob;
}

function boundedRasterScale(
  width: number,
  height: number,
  maximumWidth: number,
  maximumHeight: number,
  maximumPixels: number,
  maximumScale = 4,
) {
  const allowedScale =
    Math.min(width, height) < 360 ? maximumScale : 1;
  return Math.min(
    allowedScale,
    maximumWidth / Math.max(1, width),
    maximumHeight / Math.max(1, height),
    Math.sqrt(maximumPixels / Math.max(1, width * height)),
  );
}

async function extractChartProfiles(file: Blob) {
  const bitmap = await createImageBitmap(file);
  try {
    const documentScale = boundedRasterScale(
      bitmap.width,
      bitmap.height,
      1920,
      1200,
      2_100_000,
    );
    const documentWidth = Math.max(
      1,
      Math.round(bitmap.width * documentScale),
    );
    const documentHeight = Math.max(
      1,
      Math.round(bitmap.height * documentScale),
    );
    const documentCanvas = document.createElement("canvas");
    documentCanvas.width = documentWidth;
    documentCanvas.height = documentHeight;
    const documentContext = documentCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!documentContext) {
      throw new Error("이미지를 분석할 수 없는 브라우저입니다.");
    }
    documentContext.imageSmoothingEnabled = true;
    documentContext.imageSmoothingQuality = "high";
    documentContext.fillStyle = "#ffffff";
    documentContext.fillRect(0, 0, documentWidth, documentHeight);
    documentContext.drawImage(bitmap, 0, 0, documentWidth, documentHeight);
    const documentPixels = documentContext.getImageData(
      0,
      0,
      documentWidth,
      documentHeight,
    ).data;
    const detection = detectChartPanels(
      documentPixels,
      documentWidth,
      documentHeight,
      4,
      { sourceScale: documentScale },
    ) as {
      panels: Array<{
        index: number;
        x: number;
        y: number;
        width: number;
        height: number;
        confidence: number;
        detectionReason: string;
        axisMode: "rectangle" | "l-axis" | "content";
      }>;
      layout: { rows: number; columns: number };
      fallbackUsed: boolean;
      detectedPanelCount: number;
      rejectedNonChartCount: number;
      truncated: boolean;
      maxPanels: number;
    };
    if (!detection.panels.length) {
      throw new Error(
        "분포 파형을 찾지 못했습니다. 텍스트·표·빈 좌표계·사각형 및 설명 도형은 검색과 학습에서 제외됩니다.",
      );
    }
    const multiplePanels = detection.panels.length > 1;
    const panels = [];

    for (const detectedPanel of detection.panels) {
      const useDetectedBounds =
        multiplePanels ||
        detectedPanel.detectionReason !== "whole-image-fallback";
      const documentBounds = useDetectedBounds
        ? {
            x: detectedPanel.x,
            y: detectedPanel.y,
            width: detectedPanel.width,
            height: detectedPanel.height,
          }
        : {
            x: 0,
            y: 0,
            width: documentWidth,
            height: documentHeight,
          };
      const sourceBounds = {
        x: Math.max(
          0,
          Math.floor(
            (documentBounds.x / documentWidth) * bitmap.width,
          ),
        ),
        y: Math.max(
          0,
          Math.floor(
            (documentBounds.y / documentHeight) * bitmap.height,
          ),
        ),
        width: Math.max(
          1,
          Math.min(
            bitmap.width,
            Math.ceil(
              (documentBounds.width / documentWidth) * bitmap.width,
            ),
          ),
        ),
        height: Math.max(
          1,
          Math.min(
            bitmap.height,
            Math.ceil(
              (documentBounds.height / documentHeight) * bitmap.height,
            ),
          ),
        ),
      };
      sourceBounds.width = Math.min(
        sourceBounds.width,
        bitmap.width - sourceBounds.x,
      );
      sourceBounds.height = Math.min(
        sourceBounds.height,
        bitmap.height - sourceBounds.y,
      );

      const analysisScale = boundedRasterScale(
        sourceBounds.width,
        sourceBounds.height,
        1100,
        720,
        800_000,
      );
      const width = Math.max(
        1,
        Math.round(sourceBounds.width * analysisScale),
      );
      const height = Math.max(
        1,
        Math.round(sourceBounds.height * analysisScale),
      );
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!context) {
        throw new Error("이미지를 분석할 수 없는 브라우저입니다.");
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(
        bitmap,
        sourceBounds.x,
        sourceBounds.y,
        sourceBounds.width,
        sourceBounds.height,
        0,
        0,
        width,
        height,
      );
      const startedAt = performance.now();
      const pixels = context.getImageData(0, 0, width, height).data;
      const foreground = buildForegroundMasks(
        pixels,
        width,
        height,
        4,
        { sourceScale: analysisScale },
      );
      const extracted = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        width,
        height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      ) as {
        profile: number[];
        descriptor: Descriptor;
        alternatives: ShapeHypothesis[];
        axesDetected: boolean;
        distributionSelection: {
          mode: "single" | "most-irregular";
          distributionCount: number;
          selectedIndex: number;
          irregularityScore: number;
        };
        preprocessing: {
          primaryMask: {
            removedLabelComponents?: number;
          };
        };
      };
      let previewBlob: Blob = file;
      if (useDetectedBounds) {
        const previewScale = Math.min(
          1,
          1280 / sourceBounds.width,
          960 / sourceBounds.height,
        );
        const previewCanvas = document.createElement("canvas");
        previewCanvas.width = Math.max(
          1,
          Math.round(sourceBounds.width * previewScale),
        );
        previewCanvas.height = Math.max(
          1,
          Math.round(sourceBounds.height * previewScale),
        );
        const previewContext = previewCanvas.getContext("2d");
        if (!previewContext) {
          throw new Error("분리 차트 미리보기를 만들 수 없습니다.");
        }
        previewContext.fillStyle = "#ffffff";
        previewContext.fillRect(
          0,
          0,
          previewCanvas.width,
          previewCanvas.height,
        );
        previewContext.drawImage(
          bitmap,
          sourceBounds.x,
          sourceBounds.y,
          sourceBounds.width,
          sourceBounds.height,
          0,
          0,
          previewCanvas.width,
          previewCanvas.height,
        );
        previewBlob = await canvasToBlob(previewCanvas);
      }
      panels.push({
        ...extracted,
        previewBlob,
        panelIndex: detectedPanel.index,
        panelCount: detection.panels.length,
        detectedPanelCount: detection.detectedPanelCount,
        rejectedNonChartCount: detection.rejectedNonChartCount,
        panelSelectionTruncated: detection.truncated,
        maxPanelCount: detection.maxPanels,
        panelBounds: {
          x: sourceBounds.x / bitmap.width,
          y: sourceBounds.y / bitmap.height,
          width: sourceBounds.width / bitmap.width,
          height: sourceBounds.height / bitmap.height,
        },
        panelConfidence: detectedPanel.confidence,
        panelMode: detectedPanel.axisMode,
        processingMs: performance.now() - startedAt,
      });
    }
    return {
      panels,
      layout: detection.layout,
      fallbackUsed: detection.fallbackUsed,
      detectedPanelCount: detection.detectedPanelCount,
      rejectedNonChartCount: detection.rejectedNonChartCount,
      truncated: detection.truncated,
      maxPanels: detection.maxPanels,
    };
  } finally {
    bitmap.close();
  }
}

function searchCorpus(
  profile: number[],
  descriptor: Descriptor,
  candidates: Candidate[],
  reranker?: Reranker,
  alternativeHypotheses: ShapeHypothesis[] = [],
  dualEncoder?: DualEncoder,
): SearchResult[] {
  return coreSearchCorpus(
    profile,
    descriptor,
    candidates,
    reranker,
    alternativeHypotheses,
    dualEncoder,
  ) as unknown as SearchResult[];
}

function ProfileCanvas({
  profile,
  label,
}: {
  profile: number[];
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#66e4c2";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    profile.forEach((value, index) => {
      const x = (index / Math.max(1, profile.length - 1)) * width;
      const y = 8 + (1 - value) * (height - 16);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }, [profile]);
  return (
    <canvas
      ref={canvasRef}
      className="profile-canvas"
      role="img"
      aria-label={label}
    />
  );
}

function standardizedProfilePngDataUrl(profile: number[]) {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 420;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("표준 Curve 미리보기를 만들 수 없습니다.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#0f8069";
  context.lineWidth = 5;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  profile.forEach((value, index) => {
    const x = 28 + (index / Math.max(1, profile.length - 1)) * 904;
    const y = 24 + (1 - clamp(value)) * 372;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  return canvas.toDataURL("image/png");
}

async function sanitizedSourceImageBlob(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("학습 원본 미리보기를 읽지 못했습니다.");
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, 1280 / bitmap.width, 960 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("학습 원본 미리보기를 만들 수 없습니다.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.86),
  );
  if (!blob) throw new Error("학습 원본 미리보기를 만들 수 없습니다.");
  return blob;
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () =>
      reject(new Error("학습 원본 미리보기를 변환하지 못했습니다.")),
    );
    reader.readAsDataURL(blob);
  });
}

const familyLabel: Record<string, string> = {
  balanced: "균형형",
  asymmetric: "비대칭형",
  "wide-tail": "Wide tail",
  compressed: "압축형",
  "retention-loss": "Retention Loss",
  "program-disturb": "Program Disturb",
  "read-disturb": "Read Disturb",
  "tail-widening": "Tail Widening",
  "over-program": "Over Program",
  "vt-shift": "Vt Shift",
};

const MANAGEMENT_PAGE_SIZE = 12;

function formatLearnedAt(value?: string) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "학습 시각 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function panelAxisModeLabel(mode: Analysis["panelMode"]) {
  if (mode === "rectangle") return "사각 프레임";
  if (mode === "l-axis") return "열린 L축";
  return "내용 기반";
}

function panelExtractionQuality(analysis: Analysis) {
  const descriptor = analysis.descriptor;
  if (descriptor.stateCount <= 0 || !descriptor.peakLocations.length) {
    return "재검토";
  }
  if (
    descriptor.regularized ||
    descriptor.observedStateCount !== descriptor.stateCount
  ) {
    return "보정됨";
  }
  if (
    descriptor.peakLocations.length === descriptor.stateCount &&
    descriptor.valleyLocations.length ===
      Math.max(0, descriptor.stateCount - 1)
  ) {
    return "형상 일치";
  }
  return "확인 필요";
}

export function VthSearchApp() {
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [learnedCandidates, setLearnedCandidates] = useState<Candidate[]>([]);
  const [panelQueries, setPanelQueries] = useState<PanelQuery[]>([]);
  const [activePanelIndex, setActivePanelIndex] = useState(0);
  const [feedback, setFeedback] = useState<Record<string, RelevanceLabel>>({});
  const [queryCode, setQueryCode] = useState("");
  const [annotatorCode, setAnnotatorCode] = useState("");
  const [feedbackSharingConsent, setFeedbackSharingConsent] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSubmissionStatus, setFeedbackSubmissionStatus] = useState("");
  const [submittedFeedbackReportId, setSubmittedFeedbackReportId] =
    useState("");
  const [
    submittedFeedbackJudgmentCount,
    setSubmittedFeedbackJudgmentCount,
  ] = useState(0);
  const [sharedRelevanceAvailable, setSharedRelevanceAvailable] =
    useState(false);
  const [sharedRelevanceStats, setSharedRelevanceStats] = useState({
    reports: 0,
    judgments: 0,
    consensusReadyQueries: 0,
  });
  const [topK, setTopK] = useState(8);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLearning, setIsLearning] = useState(false);
  const [trainingLabel, setTrainingLabel] = useState("");
  const [sharingConsent, setSharingConsent] = useState(false);
  const [learningStatus, setLearningStatus] = useState("");
  const [learningTab, setLearningTab] = useState<"register" | "manage">(
    "register",
  );
  const [managementQuery, setManagementQuery] = useState("");
  const [managementPage, setManagementPage] = useState(0);
  const [selectedLearnedCandidateIds, setSelectedLearnedCandidateIds] =
    useState<string[]>([]);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [isDeletingLearnedCandidates, setIsDeletingLearnedCandidates] =
    useState(false);
  const [sharedTrainingAvailable, setSharedTrainingAvailable] = useState(false);
  const [sharedCandidateCount, setSharedCandidateCount] = useState(0);
  const standaloneMode = useSyncExternalStore(
    () => () => {},
    isStandaloneRuntime,
    () => false,
  );
  const [isDownloadingWindows, setIsDownloadingWindows] = useState(false);
  const [windowsDownloadStatus, setWindowsDownloadStatus] = useState("");
  const [isDownloadingUbuntu, setIsDownloadingUbuntu] = useState(false);
  const [ubuntuDownloadStatus, setUbuntuDownloadStatus] = useState("");
  const [error, setError] = useState("");
  const [expandedImage, setExpandedImage] =
    useState<ExpandedImage | null>(null);
  const activePanelQuery =
    panelQueries[
      Math.min(activePanelIndex, Math.max(0, panelQueries.length - 1))
    ] ?? null;
  const analysis = activePanelQuery?.analysis ?? null;
  const results = activePanelQuery?.results ?? [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchFilesInputRef = useRef<HTMLInputElement>(null);
  const batchFolderInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const annotatorIdRef = useRef("");
  const lastDemoIdRef = useRef("");
  const lastMultichartSampleUrlRef = useRef("");
  const panelQueriesRef = useRef<PanelQuery[]>([]);
  const panelInteractionsRef = useRef<Map<string, PanelInteraction>>(
    new Map(),
  );
  const analysisBusyRef = useRef(false);
  const learningBusyRef = useRef(false);
  const feedbackSubmissionRef = useRef(false);
  const allCandidates = useMemo(
    () =>
      mergeCandidateSets(
        corpus?.candidates ?? [],
        learnedCandidates,
      ) as Candidate[],
    [corpus?.candidates, learnedCandidates],
  );
  const filteredLearnedCandidates = useMemo(() => {
    const query = managementQuery.trim().toLocaleLowerCase("ko-KR");
    if (!query) return learnedCandidates;
    return learnedCandidates.filter((candidate) =>
      [
        candidate.label,
        candidate.id,
        `${candidate.stateCount}-state`,
        candidate.storage,
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase("ko-KR")
          .includes(query),
      ),
    );
  }, [learnedCandidates, managementQuery]);
  const deletableCandidateIds = useMemo(
    () => deletableLearnedCandidateIds(learnedCandidates) as string[],
    [learnedCandidates],
  );
  const filteredDeletableCandidateIds = useMemo(
    () =>
      deletableLearnedCandidateIds(filteredLearnedCandidates) as string[],
    [filteredLearnedCandidates],
  );
  const managementPageCount = Math.max(
    1,
    Math.ceil(filteredLearnedCandidates.length / MANAGEMENT_PAGE_SIZE),
  );
  const safeManagementPage = Math.min(
    managementPage,
    managementPageCount - 1,
  );
  const visibleManagedCandidates = filteredLearnedCandidates.slice(
    safeManagementPage * MANAGEMENT_PAGE_SIZE,
    (safeManagementPage + 1) * MANAGEMENT_PAGE_SIZE,
  );
  const effectiveSelectedCandidateIds = useMemo(
    () =>
      selectedLearnedCandidateIds.filter((candidateId) =>
        deletableCandidateIds.includes(candidateId),
      ),
    [deletableCandidateIds, selectedLearnedCandidateIds],
  );
  const selectedCandidateIdSet = useMemo(
    () => new Set(effectiveSelectedCandidateIds),
    [effectiveSelectedCandidateIds],
  );
  const allFilteredDeletableSelected =
    filteredDeletableCandidateIds.length > 0 &&
    filteredDeletableCandidateIds.every((candidateId) =>
      selectedCandidateIdSet.has(candidateId),
    );

  const getAnonymousAnnotatorId = () => {
    if (annotatorIdRef.current) return annotatorIdRef.current;
    const createId = () =>
      `A-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      const storageKey = "vth-anonymous-annotator-id";
      const stored = window.localStorage.getItem(storageKey);
      const id = stored || createId();
      if (!stored) window.localStorage.setItem(storageKey, id);
      annotatorIdRef.current = id;
    } catch {
      annotatorIdRef.current = createId();
    }
    return annotatorIdRef.current;
  };

  useEffect(() => {
    fetch("/corpus-index.json")
      .then((response) => {
        if (!response.ok) throw new Error("검색 인덱스를 불러오지 못했습니다.");
        return response.json() as Promise<Corpus>;
      })
      .then(setCorpus)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    let active = true;
    const loadSharedCandidates = async () => {
      try {
        if (isStandaloneRuntime()) {
          const [runtimeResponse, samplesResponse] = await Promise.all([
            fetch("/api/v1/runtime", {
              headers: { accept: "application/json" },
            }),
            fetch("/api/v1/training-samples", {
              headers: { accept: "application/json" },
            }),
          ]);
          const runtime = await runtimeResponse.json();
          const collection = (await samplesResponse.json()) as {
            samples?: Candidate[];
          };
          if (
            !runtimeResponse.ok ||
            !samplesResponse.ok ||
            runtime?.mode !== "standalone-offline" ||
            runtime?.externalNetworkAllowed !== false
          ) {
            throw new Error("로컬 학습 저장소를 불러오지 못했습니다.");
          }
          if (!active) return;
          const localCandidates = (collection.samples ?? []).map(
            (candidate: Candidate) =>
              buildLearnedCandidate({
                ...candidate,
                storage: "api",
                canDelete: true,
              }) as Candidate,
          );
          setLearnedCandidates(localCandidates);
          setSharedCandidateCount(localCandidates.length);
          setSharedTrainingAvailable(true);
          return;
        }
        const [healthResponse, collection] = await Promise.all([
          fetch(sharedApiUrl("/api/v1/shared-training-health"), {
            headers: { accept: "application/json" },
          }),
          fetchAllSharedTrainingCandidates({
            fetchImpl: fetch,
            endpoint: sharedApiUrl("/api/v1/shared-training-samples"),
          }),
        ]);
        const health = await healthResponse.json();
        if (
          !healthResponse.ok ||
          health?.service !== "vth-shared-training-api" ||
          !health?.writable
        ) {
          throw new Error("공용 학습 저장소를 불러오지 못했습니다.");
        }
        if (!active) return;
        const sharedCandidates = collection.candidates.map(
          (candidate: Candidate) => {
            let canDelete = false;
            try {
              canDelete = Boolean(
                window.localStorage.getItem(
                  sharedCandidateDeletionStorageKey(candidate.id),
                ),
              );
            } catch {
              canDelete = false;
            }
            return buildLearnedCandidate({
              ...candidate,
              storage: "shared",
              canDelete,
            }) as Candidate;
          },
        );
        setLearnedCandidates(sharedCandidates);
        setSharedCandidateCount(collection.candidateCount);
        setSharedTrainingAvailable(true);
      } catch {
        if (!active) return;
        setSharedTrainingAvailable(false);
      }
    };
    void loadSharedCandidates();
    const refreshTimer = window.setInterval(
      () => void loadSharedCandidates(),
      60_000,
    );
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    if (isStandaloneRuntime()) return;
    let active = true;
    const loadSharedRelevanceStats = async () => {
      try {
        const response = await fetch(
          sharedApiUrl("/api/v1/shared-relevance-health"),
          { headers: { accept: "application/json" } },
        );
        const payload = await response.json();
        if (
          !response.ok ||
          payload?.service !== "vth-shared-relevance-api" ||
          !payload?.writable
        ) {
          throw new Error("공용 relevance 저장소를 불러오지 못했습니다.");
        }
        if (!active) return;
        setSharedRelevanceAvailable(true);
        setSharedRelevanceStats({
          reports: Number(payload.reports ?? 0),
          judgments: Number(payload.judgments ?? 0),
          consensusReadyQueries: Number(payload.consensusReadyQueries ?? 0),
        });
      } catch {
        if (!active) return;
        setSharedRelevanceAvailable(false);
      }
    };
    void loadSharedRelevanceStats();
    const refreshTimer = window.setInterval(
      () => void loadSharedRelevanceStats(),
      60_000,
    );
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    panelQueriesRef.current = panelQueries;
  }, [panelQueries]);

  useEffect(
    () => () => {
      for (const panelQuery of panelQueriesRef.current) {
        URL.revokeObjectURL(panelQuery.analysis.imageUrl);
      }
    },
    [],
  );

  useEffect(() => {
    if (!expandedImage) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedImage(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expandedImage]);

  const analyzeFile = useCallback(
    async (file: File) => {
      setError("");
      if (analysisBusyRef.current) return;
      if (learningBusyRef.current) {
        setError("차트 학습이 끝난 뒤 새 그림을 분석해 주세요.");
        return;
      }
      if (feedbackSubmissionRef.current) {
        setError("평가 제출이 끝난 뒤 새 그림을 분석해 주세요.");
        return;
      }
      if (!isSupportedBatchImage(file)) {
        setError("PNG, JPG 또는 WEBP 이미지 한 장을 선택해 주세요.");
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError("이미지는 12MB 이하만 분석할 수 있습니다.");
        return;
      }
      if (!corpus) {
        setError("검색 인덱스를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }

      analysisBusyRef.current = true;
      setIsAnalyzing(true);
      setFeedback({});
      setFeedbackSharingConsent(false);
      setFeedbackSubmissionStatus("");
      setSubmittedFeedbackReportId("");
      setSubmittedFeedbackJudgmentCount(0);
      const nextPanelQueries: PanelQuery[] = [];
      const createdImageUrls: string[] = [];
      try {
        const documentAnalysis = await extractChartProfiles(file);
        for (const [panelIndex, extracted] of
          documentAnalysis.panels.entries()) {
          const analysisId = crypto.randomUUID();
          const ranked = searchCorpus(
            extracted.profile,
            extracted.descriptor,
            allCandidates,
            corpus.reranker,
            extracted.alternatives,
            corpus.dualEncoder,
          );
          const imageUrl = URL.createObjectURL(extracted.previewBlob);
          createdImageUrls.push(imageUrl);
          nextPanelQueries.push({
            analysis: {
              id: analysisId,
              fileName:
                documentAnalysis.panels.length > 1
                  ? `${file.name} · 차트 ${panelIndex + 1}/${documentAnalysis.panels.length}`
                  : file.name,
              imageUrl,
              panelIndex,
              panelCount: documentAnalysis.panels.length,
              detectedPanelCount: documentAnalysis.detectedPanelCount,
              rejectedNonChartCount:
                documentAnalysis.rejectedNonChartCount,
              panelSelectionTruncated: documentAnalysis.truncated,
              maxPanelCount: documentAnalysis.maxPanels,
              panelBounds: extracted.panelBounds,
              panelConfidence: extracted.panelConfidence,
              panelMode: extracted.panelMode,
              profile: extracted.profile,
              descriptor: extracted.descriptor,
              axesDetected: extracted.axesDetected,
              processingMs: extracted.processingMs,
              curveHypothesisCount: 1 + extracted.alternatives.length,
              distributionCount:
                extracted.distributionSelection.distributionCount,
              selectedDistributionIndex:
                extracted.distributionSelection.selectedIndex,
              irregularityScore:
                extracted.distributionSelection.irregularityScore,
              removedLabelCount:
                extracted.preprocessing.primaryMask.removedLabelComponents ??
                0,
            },
            results: ranked,
          });
        }
        panelInteractionsRef.current = new Map(
          nextPanelQueries.map((panelQuery) => [
            panelQuery.analysis.id,
            {
              feedback: {},
              queryCode: `Q-${panelQuery.analysis.id.slice(0, 8).toUpperCase()}`,
              feedbackSharingConsent: false,
              feedbackSubmissionStatus: "",
              submittedFeedbackReportId: "",
              submittedFeedbackJudgmentCount: 0,
            },
          ]),
        );
        setQueryCode(
          panelInteractionsRef.current.get(
            nextPanelQueries[0].analysis.id,
          )?.queryCode ?? "",
        );
        setTrainingLabel(
          isStandaloneRuntime() ? "내 VTH 분포" : "공용 VTH 분포",
        );
        setSharingConsent(false);
        setLearningStatus("");
        setActivePanelIndex(0);
        const previousPanelQueries = panelQueriesRef.current;
        panelQueriesRef.current = nextPanelQueries;
        setPanelQueries(nextPanelQueries);
        for (const panelQuery of previousPanelQueries) {
          URL.revokeObjectURL(panelQuery.analysis.imageUrl);
        }
      } catch (caught) {
        for (const imageUrl of createdImageUrls) {
          URL.revokeObjectURL(imageUrl);
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "그래프를 분석하지 못했습니다. 다른 이미지를 시도해 주세요.",
        );
      } finally {
        analysisBusyRef.current = false;
        setIsAnalyzing(false);
      }
    },
    [allCandidates, corpus],
  );

  const selectAnalyzedPanel = (panelIndex: number) => {
    if (feedbackSubmissionRef.current) return;
    const nextPanel = panelQueries[panelIndex];
    if (!nextPanel || panelIndex === activePanelIndex) return;
    if (analysis) {
      panelInteractionsRef.current.set(analysis.id, {
        feedback,
        queryCode,
        feedbackSharingConsent,
        feedbackSubmissionStatus,
        submittedFeedbackReportId,
        submittedFeedbackJudgmentCount,
      });
    }
    const nextInteraction =
      panelInteractionsRef.current.get(nextPanel.analysis.id) ?? {
        feedback: {},
        queryCode: `Q-${nextPanel.analysis.id.slice(0, 8).toUpperCase()}`,
        feedbackSharingConsent: false,
        feedbackSubmissionStatus: "",
        submittedFeedbackReportId: "",
        submittedFeedbackJudgmentCount: 0,
      };
    panelInteractionsRef.current.set(
      nextPanel.analysis.id,
      nextInteraction,
    );
    setActivePanelIndex(panelIndex);
    setFeedback(nextInteraction.feedback);
    setFeedbackSharingConsent(
      nextInteraction.feedbackSharingConsent,
    );
    setFeedbackSubmissionStatus(
      nextInteraction.feedbackSubmissionStatus,
    );
    setSubmittedFeedbackReportId(
      nextInteraction.submittedFeedbackReportId,
    );
    setSubmittedFeedbackJudgmentCount(
      nextInteraction.submittedFeedbackJudgmentCount,
    );
    setQueryCode(nextInteraction.queryCode);
  };

  const toggleFeedback = (candidateId: string, label: RelevanceLabel) => {
    setFeedback((current) => {
      const next = { ...current };
      if (next[candidateId] === label) delete next[candidateId];
      else next[candidateId] = label;
      return next;
    });
  };

  const exportFeedback = () => {
    if (!analysis || !corpus) return;
    const payload = buildFeedbackPayload({
      analysis,
      corpus,
      results,
      feedback,
      queryCode,
      annotatorId: annotatorCode || getAnonymousAnnotatorId(),
    });
    const downloadUrl = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `vth-feedback-${payload.query.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
  };

  const submitSharedFeedback = async () => {
    const judgmentSelectionCount = Object.keys(feedback).length;
    if (!analysis || !corpus || !judgmentSelectionCount) return;
    if (isStandaloneRuntime()) {
      exportFeedback();
      setFeedbackSubmissionStatus(
        "평가 JSON을 이 PC에 저장했습니다. 외부로 전송하지 않았습니다.",
      );
      return;
    }
    if (!feedbackSharingConsent) {
      setError("익명 relevance 판정의 공용 학습 공유에 동의해 주세요.");
      return;
    }
    if (!sharedRelevanceAvailable) {
      setError("공용 relevance 저장소에 연결할 수 없습니다.");
      return;
    }
    feedbackSubmissionRef.current = true;
    setIsSubmittingFeedback(true);
    setError("");
    try {
      let contributorToken = "";
      try {
        contributorToken =
          window.localStorage.getItem(RELEVANCE_CONTRIBUTOR_TOKEN_KEY) || "";
        if (!contributorToken) {
          contributorToken = createSharingToken();
          window.localStorage.setItem(
            RELEVANCE_CONTRIBUTOR_TOKEN_KEY,
            contributorToken,
          );
        }
      } catch {
        contributorToken = createSharingToken();
      }
      const deletionToken = createSharingToken();
      const report = buildFeedbackPayload({
        analysis,
        corpus,
        results,
        feedback,
        queryCode,
        annotatorId: annotatorCode || getAnonymousAnnotatorId(),
        normalizedShapeShared: true,
      });
      const response = await fetch(
        sharedApiUrl("/api/v1/shared-relevance-reports"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(
            buildSharedRelevanceApiPayload(report, {
              contributorToken,
              deletionToken,
              consentVersion: SHARED_RELEVANCE_CONSENT_VERSION,
            }),
          ),
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload?.report?.id) {
        throw new Error(
          payload?.error?.message ||
            `공용 relevance 저장에 실패했습니다 (${response.status}).`,
        );
      }
      try {
        window.localStorage.setItem(
          sharedRelevanceDeletionStorageKey(payload.report.id),
          deletionToken,
        );
      } catch {
        await fetch(
          sharedApiUrl(
            `/api/v1/shared-relevance-reports/${encodeURIComponent(payload.report.id)}`,
          ),
          {
            method: "DELETE",
            headers: {
              accept: "application/json",
              "x-vth-delete-token": deletionToken,
            },
          },
        );
        throw new Error(
          "삭제 권한을 안전하게 보관할 수 없어 공용 판정 등록을 취소했습니다.",
        );
      }
      const judgmentCount = Number(
        payload.report.judgmentCount ?? judgmentSelectionCount,
      );
      const previousJudgmentCount = Number(
        payload.previousJudgmentCount ?? 0,
      );
      setSubmittedFeedbackReportId(payload.report.id);
      setSubmittedFeedbackJudgmentCount(judgmentCount);
      setSharedRelevanceStats((current) => ({
        ...current,
        reports:
          current.reports +
          (payload.updated ? 0 : 1),
        judgments:
          current.judgments - previousJudgmentCount + judgmentCount,
      }));
      setFeedbackSubmissionStatus(
        payload.updated
          ? "같은 Query·평가자의 공용 판정을 최신 내용으로 갱신했습니다."
          : "익명 판정을 공용 재학습 데이터로 등록했습니다.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "공용 relevance 판정을 저장하지 못했습니다.",
      );
    } finally {
      feedbackSubmissionRef.current = false;
      setIsSubmittingFeedback(false);
    }
  };

  const removeSubmittedFeedback = async () => {
    if (!submittedFeedbackReportId) return;
    if (isStandaloneRuntime()) return;
    setError("");
    try {
      const deletionToken =
        window.localStorage.getItem(
          sharedRelevanceDeletionStorageKey(submittedFeedbackReportId),
        ) || "";
      if (!deletionToken) {
        throw new Error("이 판정을 제출한 브라우저의 삭제 토큰이 없습니다.");
      }
      const response = await fetch(
        sharedApiUrl(
          `/api/v1/shared-relevance-reports/${encodeURIComponent(submittedFeedbackReportId)}`,
        ),
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            "x-vth-delete-token": deletionToken,
          },
        },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(
          payload?.error?.message ||
            `공용 relevance 삭제에 실패했습니다 (${response.status}).`,
        );
      }
      window.localStorage.removeItem(
        sharedRelevanceDeletionStorageKey(submittedFeedbackReportId),
      );
      setSharedRelevanceStats((current) => ({
        ...current,
        reports: Math.max(0, current.reports - 1),
        judgments: Math.max(
          0,
          current.judgments - submittedFeedbackJudgmentCount,
        ),
      }));
      setSubmittedFeedbackReportId("");
      setSubmittedFeedbackJudgmentCount(0);
      setFeedbackSubmissionStatus("공용 relevance 판정을 삭제했습니다.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "공용 relevance 판정을 삭제하지 못했습니다.",
      );
    }
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void analyzeFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void analyzeFile(file);
  };

  useEffect(() => {
    const handlePaste = (event: globalThis.ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!imageItem) return;
      if (
        analysisBusyRef.current ||
        learningBusyRef.current ||
        feedbackSubmissionRef.current
      ) {
        setError("진행 중인 분석·학습·평가가 끝난 뒤 붙여넣어 주세요.");
        return;
      }
      event.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) {
        setError("클립보드의 이미지를 읽지 못했습니다.");
        return;
      }
      const extension =
        blob.type === "image/jpeg"
          ? "jpg"
          : blob.type === "image/webp"
            ? "webp"
            : "png";
      void analyzeFile(
        new File([blob], `clipboard-${Date.now()}.${extension}`, {
          type: blob.type || "image/png",
        }),
      );
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [analyzeFile]);

  const runDemo = async () => {
    setError("");
    try {
      if (
        analysisBusyRef.current ||
        learningBusyRef.current ||
        feedbackSubmissionRef.current
      ) {
        throw new Error("진행 중인 작업이 있습니다.");
      }
      if (!corpus) throw new Error("데모 코퍼스가 준비되지 않았습니다.");
      const candidate = chooseRandomDemoCandidate(
        corpus.candidates,
        lastDemoIdRef.current,
        Math.random(),
      ) as Candidate | null;
      if (!candidate) throw new Error("데모 후보가 없습니다.");
      lastDemoIdRef.current = candidate.id;
      const response = await fetch(candidate.image);
      if (!response.ok) throw new Error("데모 이미지를 불러오지 못했습니다.");
      const blob = await response.blob();
      await analyzeFile(
        new File([blob], `demo-${candidate.id}.png`, {
          type: blob.type || "image/png",
        }),
      );
    } catch {
      setError("데모 그래프를 불러오지 못했습니다.");
    }
  };

  const runRandomMultichartSample = async () => {
    setError("");
    try {
      if (
        analysisBusyRef.current ||
        learningBusyRef.current ||
        feedbackSubmissionRef.current
      ) {
        throw new Error("진행 중인 작업이 있습니다.");
      }
      if (!corpus) throw new Error("검색 코퍼스가 준비되지 않았습니다.");
      const alternatives = RANDOM_MULTICHART_SAMPLES.filter(
        (sample) =>
          sample.url !== lastMultichartSampleUrlRef.current,
      );
      const candidates = alternatives.length
        ? alternatives
        : RANDOM_MULTICHART_SAMPLES;
      const sample =
        candidates[Math.floor(Math.random() * candidates.length)];
      lastMultichartSampleUrlRef.current = sample.url;
      const response = await fetch(sample.url);
      if (!response.ok) {
        throw new Error("멀티 차트 샘플 이미지를 불러오지 못했습니다.");
      }
      const blob = await response.blob();
      await analyzeFile(
        new File([blob], sample.fileName, {
          type: "image/png",
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "멀티 차트 샘플 이미지를 불러오지 못했습니다.",
      );
    }
  };

  const assertTrainingReady = () => {
    if (!sharingConsent) {
      throw new Error(
        isStandaloneRuntime()
          ? "표준 Curve를 이 PC의 학습 저장소에 보관하는 데 동의해 주세요."
          : "표준 Curve의 공용 학습 후보 공유에 동의해 주세요.",
      );
    }
    if (!sharedTrainingAvailable) {
      throw new Error(
        isStandaloneRuntime()
          ? "이 PC의 로컬 학습 저장소를 사용할 수 없습니다."
          : "공용 학습 저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  };

  const storeTrainingAnalysis = async (
    trainingAnalysis: Analysis,
    label: string,
  ) => {
    const sourceImageBlob = await sanitizedSourceImageBlob(
      trainingAnalysis.imageUrl,
    );
    if (isStandaloneRuntime()) {
      const pendingCandidate = buildLearnedCandidate({
        id: `local-${crypto.randomUUID()}`,
        label,
        image: "",
        profile: trainingAnalysis.profile,
        descriptor: trainingAnalysis.descriptor,
        storage: "api",
        canDelete: true,
      }) as Candidate;
      const response = await fetch("/api/v1/training-samples", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(
          buildTrainingApiPayload(
            pendingCandidate,
            standardizedProfilePngDataUrl(trainingAnalysis.profile),
            await blobToDataUrl(sourceImageBlob),
          ),
        ),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.sample) {
        throw new Error(
          payload?.error?.message ||
            `로컬 학습 저장에 실패했습니다 (${response.status}).`,
        );
      }
      return {
        candidate: buildLearnedCandidate({
          ...payload.sample,
          storage: "api",
          canDelete: true,
        }) as Candidate,
        added: true,
        deduplicated: false,
      };
    }

    let contributorToken = "";
    try {
      contributorToken =
        window.localStorage.getItem(CONTRIBUTOR_TOKEN_KEY) || "";
      if (!contributorToken) {
        contributorToken = createSharingToken();
        window.localStorage.setItem(
          CONTRIBUTOR_TOKEN_KEY,
          contributorToken,
        );
      }
    } catch {
      contributorToken = createSharingToken();
    }
    const deletionToken = createSharingToken();
    const pendingCandidate = buildLearnedCandidate({
      id: `shared-pending-${crypto.randomUUID()}`,
      label,
      image: "",
      profile: trainingAnalysis.profile,
      descriptor: trainingAnalysis.descriptor,
      storage: "shared",
    }) as Candidate;
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify(
        buildSharedTrainingApiPayload(
          pendingCandidate,
          trainingAnalysis.descriptor,
          {
            contributorToken,
            deletionToken,
            consentVersion: SHARED_TRAINING_CONSENT_VERSION,
          },
        ),
      ),
    );
    form.append("sourceImage", sourceImageBlob, "source-preview.jpg");
    const response = await fetch(
      sharedApiUrl("/api/v1/shared-training-samples"),
      {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      },
    );
    const payload = await response.json();
    if (!response.ok || !payload?.candidate) {
      throw new Error(
        payload?.error?.message ||
          `공용 학습 저장에 실패했습니다 (${response.status}).`,
      );
    }
    const canDelete = !payload.deduplicated;
    if (canDelete) {
      try {
        window.localStorage.setItem(
          sharedCandidateDeletionStorageKey(payload.candidate.id),
          deletionToken,
        );
      } catch {
        await fetch(
          sharedApiUrl(
            `/api/v1/shared-training-samples/${encodeURIComponent(payload.candidate.id)}`,
          ),
          {
            method: "DELETE",
            headers: {
              accept: "application/json",
              "x-vth-delete-token": deletionToken,
            },
          },
        );
        throw new Error(
          "삭제 권한을 안전하게 보관할 수 없어 공용 등록을 취소했습니다.",
        );
      }
    }
    return {
      candidate: buildLearnedCandidate({
        ...payload.candidate,
        storage: "shared",
        canDelete,
      }) as Candidate,
      added: !payload.deduplicated,
      deduplicated: Boolean(payload.deduplicated),
    };
  };

  const learnCurrentImage = async () => {
    if (!panelQueries.length) return;
    if (learningBusyRef.current || analysisBusyRef.current) {
      setError("진행 중인 분석 또는 학습이 끝난 뒤 다시 시도해 주세요.");
      return;
    }
    learningBusyRef.current = true;
    setIsLearning(true);
    setError("");
    try {
      assertTrainingReady();
      const baseLabel =
        trainingLabel.trim() ||
        (isStandaloneRuntime() ? "내 VTH 분포" : "공용 VTH 분포");
      const outcomes = [];
      const failures: string[] = [];
      for (const [panelIndex, panelQuery] of panelQueries.entries()) {
        setLearningStatus(
          panelQueries.length > 1
            ? `분리 차트 ${panelIndex + 1}/${panelQueries.length} 저장 중…`
            : "현재 차트 저장 중…",
        );
        try {
          outcomes.push(
            await storeTrainingAnalysis(
              panelQuery.analysis,
              panelQueries.length > 1
                ? `${baseLabel} · 차트 ${panelIndex + 1}/${panelQueries.length}`
                : baseLabel,
            ),
          );
        } catch (caught) {
          failures.push(
            caught instanceof Error
              ? caught.message
              : `차트 ${panelIndex + 1} 저장 실패`,
          );
        }
      }
      if (!outcomes.length) {
        throw new Error(
          failures[0] || "분리된 차트를 학습 후보로 저장하지 못했습니다.",
        );
      }
      setLearnedCandidates((current) =>
        mergeCandidateSets(
          [],
          current,
          outcomes.map((outcome) => outcome.candidate),
        ) as Candidate[],
      );
      const added = outcomes.filter((outcome) => outcome.added).length;
      const deduplicated = outcomes.filter(
        (outcome) => outcome.deduplicated,
      ).length;
      if (added) {
        setSharedCandidateCount((current) => current + added);
      }
      setLearningStatus(
        panelQueries.length > 1
          ? `${panelQueries.length}개 차트를 개별 후보로 처리했습니다 · 신규 ${added}개` +
              `${deduplicated ? ` · 중복 연결 ${deduplicated}개` : ""}` +
              `${failures.length ? ` · 실패 ${failures.length}개` : ""}`
          : deduplicated
            ? "동일한 형상이 이미 학습 코퍼스에 있어 기존 후보와 연결했습니다."
            : isStandaloneRuntime()
              ? "표준 Curve와 메타데이터를 제거한 원본 미리보기를 이 PC의 data 폴더에 저장했습니다. 추천 시 함께 표시되며 외부 전송은 없습니다."
              : "표준 Curve와 메타데이터를 제거한 원본 미리보기를 공용 학습 코퍼스에 등록했습니다. 추천 시 원본도 함께 표시되며 다른 사용자의 검색에도 즉시 노출됩니다.",
      );
      if (failures.length) {
        setError(`일부 차트를 저장하지 못했습니다. 첫 오류: ${failures[0]}`);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "학습 후보를 저장하지 못했습니다.",
      );
    } finally {
      learningBusyRef.current = false;
      setIsLearning(false);
    }
  };

  const learnBatchFiles = async (files: FileList | File[]) => {
    if (learningBusyRef.current || analysisBusyRef.current) {
      setError("진행 중인 분석 또는 학습이 끝난 뒤 다시 시도해 주세요.");
      return;
    }
    setError("");
    setLearningStatus("");
    const selection = prepareBatchTrainingFiles(files, {
      maximumBytes: MAX_FILE_SIZE,
    });
    try {
      assertTrainingReady();
      if (!selection.accepted.length) {
        throw new Error(
          "학습할 수 있는 PNG, JPG 또는 WEBP 이미지가 없습니다.",
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "일괄 학습을 시작하지 못했습니다.",
      );
      return;
    }

    learningBusyRef.current = true;
    setIsLearning(true);
    try {
      const batch = await runSequentialBatchTraining(
        selection.accepted,
        async (file: File, index: number, total: number) => {
          const documentAnalysis = await extractChartProfiles(file);
          const outcomes = [];
          const panelFailures: string[] = [];
          const baseLabel = buildBatchTrainingLabel(
            trainingLabel,
            index,
            total,
            isStandaloneRuntime(),
          );
          for (const [panelIndex, extracted] of
            documentAnalysis.panels.entries()) {
            const imageUrl = URL.createObjectURL(extracted.previewBlob);
            try {
              outcomes.push(
                await storeTrainingAnalysis(
                  {
                    id: crypto.randomUUID(),
                    fileName:
                      documentAnalysis.panels.length > 1
                        ? `${file.name} · 차트 ${panelIndex + 1}/${documentAnalysis.panels.length}`
                        : file.name,
                    imageUrl,
                    panelIndex,
                    panelCount: documentAnalysis.panels.length,
                    detectedPanelCount:
                      documentAnalysis.detectedPanelCount,
                    rejectedNonChartCount:
                      documentAnalysis.rejectedNonChartCount,
                    panelSelectionTruncated:
                      documentAnalysis.truncated,
                    maxPanelCount: documentAnalysis.maxPanels,
                    panelBounds: extracted.panelBounds,
                    panelConfidence: extracted.panelConfidence,
                    panelMode: extracted.panelMode,
                    profile: extracted.profile,
                    descriptor: extracted.descriptor,
                    axesDetected: extracted.axesDetected,
                    processingMs: extracted.processingMs,
                    curveHypothesisCount:
                      1 + extracted.alternatives.length,
                    distributionCount:
                      extracted.distributionSelection.distributionCount,
                    selectedDistributionIndex:
                      extracted.distributionSelection.selectedIndex,
                    irregularityScore:
                      extracted.distributionSelection.irregularityScore,
                    removedLabelCount:
                      extracted.preprocessing.primaryMask
                        .removedLabelComponents ?? 0,
                  },
                  documentAnalysis.panels.length > 1
                    ? `${baseLabel} · 차트 ${panelIndex + 1}/${documentAnalysis.panels.length}`
                    : baseLabel,
                ),
              );
            } catch (caught) {
              panelFailures.push(
                caught instanceof Error
                  ? caught.message
                  : `차트 ${panelIndex + 1} 저장 실패`,
              );
            } finally {
              URL.revokeObjectURL(imageUrl);
            }
          }
          if (!outcomes.length) {
            throw new Error(
              panelFailures[0] ||
                "이 파일에서 분리한 차트를 저장하지 못했습니다.",
            );
          }
          return {
            outcomes,
            panelFailures,
            panelCount: documentAnalysis.panels.length,
            detectedPanelCount: documentAnalysis.detectedPanelCount,
            truncated: documentAnalysis.truncated,
          };
        },
        ({ completed, total }: { completed: number; total: number }) => {
          setLearningStatus(
            completed >= total
              ? `일괄 학습 ${total}/${total} 처리 완료`
              : `일괄 학습 ${completed + 1}/${total} 분석·저장 중…`,
          );
        },
      );
      const fileSuccesses = batch.successes as Array<{
        outcomes: Array<{
          candidate: Candidate;
          added: boolean;
          deduplicated: boolean;
        }>;
        panelFailures: string[];
        panelCount: number;
        detectedPanelCount: number;
        truncated: boolean;
      }>;
      const panelOutcomes = fileSuccesses.flatMap(
        (fileOutcome) => fileOutcome.outcomes,
      );
      const candidates = panelOutcomes.map(
        (outcome) => outcome.candidate,
      );
      const added = panelOutcomes.filter(
        (outcome: { added: boolean }) => outcome.added,
      ).length;
      const deduplicated = panelOutcomes.filter(
        (outcome: { deduplicated: boolean }) => outcome.deduplicated,
      ).length;
      const analyzedPanels = fileSuccesses.reduce(
        (sum, fileOutcome) => sum + fileOutcome.panelCount,
        0,
      );
      const detectedPanels = fileSuccesses.reduce(
        (sum, fileOutcome) => sum + fileOutcome.detectedPanelCount,
        0,
      );
      const truncatedFiles = fileSuccesses.filter(
        (fileOutcome) => fileOutcome.truncated,
      ).length;
      const panelFailures = fileSuccesses.flatMap(
        (fileOutcome) => fileOutcome.panelFailures,
      );
      if (candidates.length) {
        setLearnedCandidates((current) =>
          mergeCandidateSets([], current, candidates) as Candidate[],
        );
      }
      if (added) {
        setSharedCandidateCount((current) => current + added);
      }
      setLearningStatus(
        `${selection.accepted.length}개 파일 처리 · 차트 ${analyzedPanels}개 분리` +
          `${truncatedFiles ? ` (총 ${detectedPanels}개 감지 · ${truncatedFiles}개 파일에 상한 적용)` : ""}` +
          ` · 후보 성공 ${panelOutcomes.length}개` +
          ` (신규 ${added}개${deduplicated ? `, 중복 ${deduplicated}개` : ""})` +
          `${panelFailures.length ? ` · 차트 실패 ${panelFailures.length}개` : ""}` +
          `${batch.failures.length ? ` · 파일 실패 ${batch.failures.length}개` : ""}` +
          `${selection.skipped ? ` · 형식/용량/한도 제외 ${selection.skipped}개` : ""}`,
      );
      if (panelFailures.length || batch.failures.length) {
        setError(
          `일부 차트를 학습하지 못했습니다. 첫 오류: ${
            panelFailures[0] || batch.failures[0].message
          }`,
        );
      }
    } finally {
      learningBusyRef.current = false;
      setIsLearning(false);
    }
  };

  const handleBatchInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void learnBatchFiles(files);
    event.target.value = "";
  };

  const deleteLearnedCandidate = async (candidateId: string) => {
    if (isStandaloneRuntime()) {
      const response = await fetch(
        `/api/v1/training-samples/${encodeURIComponent(candidateId)}`,
        {
          method: "DELETE",
          headers: { accept: "application/json" },
        },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(
          payload?.error?.message ||
            `로컬 학습 후보 삭제에 실패했습니다 (${response.status}).`,
        );
      }
    } else {
      let deletionToken = "";
      try {
        deletionToken =
          window.localStorage.getItem(
            sharedCandidateDeletionStorageKey(candidateId),
          ) || "";
      } catch {
        deletionToken = "";
      }
      if (!deletionToken) {
        throw new Error("이 후보를 등록한 브라우저의 삭제 토큰이 없습니다.");
      }
      const response = await fetch(
        sharedApiUrl(
          `/api/v1/shared-training-samples/${encodeURIComponent(candidateId)}`,
        ),
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            "x-vth-delete-token": deletionToken,
          },
        },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(
          payload?.error?.message ||
            `공용 학습 후보 삭제에 실패했습니다 (${response.status}).`,
        );
      }
      try {
        window.localStorage.removeItem(
          sharedCandidateDeletionStorageKey(candidateId),
        );
      } catch {
        // Deletion already succeeded remotely.
      }
    }
    setLearnedCandidates((current) =>
      current.filter((candidate) => candidate.id !== candidateId),
    );
    setPanelQueries((current) =>
      current.map((panelQuery) => ({
        ...panelQuery,
        results: panelQuery.results.filter(
          (candidate) => candidate.id !== candidateId,
        ),
      })),
    );
    setSelectedLearnedCandidateIds((current) =>
      current.filter((id) => id !== candidateId),
    );
    setSharedCandidateCount((current) => Math.max(0, current - 1));
  };

  const removeLearnedCandidate = async (candidateId: string) => {
    setError("");
    try {
      await deleteLearnedCandidate(candidateId);
      setLearningStatus(
        standaloneMode
          ? "이 PC의 로컬 학습 후보를 삭제했습니다."
          : "공용 학습 후보를 삭제했습니다.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "학습 후보를 삭제하지 못했습니다.",
      );
    }
  };

  const toggleLearnedCandidateSelection = (candidateId: string) => {
    setDeleteConfirmationOpen(false);
    setSelectedLearnedCandidateIds((current) =>
      current.includes(candidateId)
        ? current.filter((id) => id !== candidateId)
        : [...current, candidateId],
    );
  };

  const toggleAllFilteredDeletableCandidates = () => {
    setDeleteConfirmationOpen(false);
    setSelectedLearnedCandidateIds((current) => {
      if (allFilteredDeletableSelected) {
        const filteredIds = new Set(filteredDeletableCandidateIds);
        return current.filter((candidateId) => !filteredIds.has(candidateId));
      }
      return [...new Set([...current, ...filteredDeletableCandidateIds])];
    });
  };

  const deleteSelectedLearnedCandidates = async () => {
    const selectedIds = effectiveSelectedCandidateIds;
    if (!selectedIds.length) return;
    setDeleteConfirmationOpen(false);
    setIsDeletingLearnedCandidates(true);
    setError("");
    setLearningStatus(`선택한 학습 데이터 0/${selectedIds.length} 삭제 중…`);
    try {
      const deletion = await deleteLearnedCandidateSelection(
        selectedIds,
        deleteLearnedCandidate,
        ({
          completed,
          total,
        }: {
          completed: number;
          total: number;
        }) => {
          setLearningStatus(
            `선택한 학습 데이터 ${completed}/${total} 삭제 중…`,
          );
        },
      );
      const deletedIds = new Set(deletion.successes as string[]);
      setSelectedLearnedCandidateIds((current) =>
        current.filter((candidateId) => !deletedIds.has(candidateId)),
      );
      setLearningStatus(
        `선택 삭제 완료 · 성공 ${deletion.successes.length}개` +
          `${deletion.failures.length ? ` · 실패 ${deletion.failures.length}개` : ""}`,
      );
      if (deletion.failures.length) {
        setError(
          `일부 학습 데이터를 삭제하지 못했습니다. 첫 오류: ${deletion.failures[0].message}`,
        );
      }
    } finally {
      setIsDeletingLearnedCandidates(false);
    }
  };

  const downloadWindowsStandalone = async () => {
    setIsDownloadingWindows(true);
    setWindowsDownloadStatus("패키지 확인 중");
    setError("");
    try {
      const download = await assembleWindowsPackage({
        onProgress: ({
          phase,
          completed,
          total,
        }: {
          phase: string;
          completed: number;
          total: number;
        }) => {
          setWindowsDownloadStatus(
            phase === "verify"
              ? "무결성 확인 중"
              : `다운로드 ${completed + 1}/${total}`,
          );
        },
      });
      const downloadUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = download.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
      setWindowsDownloadStatus(`v${download.manifest.version} 저장 완료`);
    } catch (caught) {
      setWindowsDownloadStatus("다운로드 실패");
      setError(
        caught instanceof Error
          ? caught.message
          : "Windows 패키지를 다운로드하지 못했습니다.",
      );
    } finally {
      setIsDownloadingWindows(false);
    }
  };

  const downloadUbuntuStandalone = async () => {
    setIsDownloadingUbuntu(true);
    setUbuntuDownloadStatus("패키지 확인 중");
    setError("");
    try {
      const download = await assembleUbuntuPackage({
        onProgress: ({
          phase,
          completed,
          total,
        }: {
          phase: string;
          completed: number;
          total: number;
        }) => {
          setUbuntuDownloadStatus(
            phase === "verify"
              ? "무결성 확인 중"
              : `다운로드 ${completed + 1}/${total}`,
          );
        },
      });
      const downloadUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = download.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
      setUbuntuDownloadStatus(`v${download.manifest.version} 저장 완료`);
    } catch (caught) {
      setUbuntuDownloadStatus("다운로드 실패");
      setError(
        caught instanceof Error
          ? caught.message
          : "Ubuntu 서버 패키지를 다운로드하지 못했습니다.",
      );
    } finally {
      setIsDownloadingUbuntu(false);
    }
  };

  const visibleResults = results.slice(0, topK);
  const feedbackCount = Object.keys(feedback).length;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="유사 산포 검색 홈">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>유사 산포 검색</span>
        </a>
        <div className="header-actions">
          <a
            className="search-api-docs"
            href={
              standaloneMode
                ? "/api/v1/openapi.json"
                : "/similarity-search-openapi.json"
            }
            target="_blank"
            rel="noreferrer"
            aria-label="이미지 유사도 검색 API 문서"
          >
            <span>IMAGE → RANK + SCORE</span>
            <strong>검색 API 문서</strong>
          </a>
          {!standaloneMode && (
            <div
              className="standalone-downloads"
              aria-label="운영체제별 단독 실행 패키지 다운로드"
            >
              <button
                type="button"
                className="windows-download"
                onClick={() => void downloadWindowsStandalone()}
                disabled={isDownloadingWindows || isDownloadingUbuntu}
                data-testid="windows-download"
                aria-label="Windows x64 완전 독립 실행판 ZIP 다운로드"
              >
                <span aria-live="polite">
                  {windowsDownloadStatus || "WINDOWS X64 · FULL OFFLINE"}
                </span>
                <strong>
                  {isDownloadingWindows ? "패키지 준비 중…" : "완전 독립판 다운로드"}
                </strong>
              </button>
              <button
                type="button"
                className="windows-download ubuntu-download"
                onClick={() => void downloadUbuntuStandalone()}
                disabled={isDownloadingWindows || isDownloadingUbuntu}
                data-testid="ubuntu-download"
                aria-label="Ubuntu x64 외부 Web 서버 독립판 다운로드"
              >
                <span aria-live="polite">
                  {ubuntuDownloadStatus || "UBUNTU X64 · WEB SERVER"}
                </span>
                <strong>
                  {isDownloadingUbuntu ? "패키지 준비 중…" : "외부 Web 서버 다운로드"}
                </strong>
              </button>
            </div>
          )}
          <div className="header-meta">
            <span className="live-dot" />
            <span>
              {corpus
                ? `${corpus.candidateCount + sharedCandidateCount} distributions · ${corpus.stateCounts.join("/")} State`
                : "Index loading"}
            </span>
            <span className="header-divider" />
            <span>{standaloneMode ? "OFFLINE · LOCAL ONLY" : "LOG10 ENGINE"}</span>
          </div>
        </div>
      </header>

      <div className={`workspace ${analysis ? "has-analysis" : ""}`}>
        <section className="hero" id="top">
        <div className="analyzer-shell">
          <div className="panel-topline">
            <span>INPUT / VTH DISTRIBUTION</span>
            <span className="privacy-label">
              {standaloneMode
                ? "완전 오프라인 · 원본/Curve 외부 전송 없음"
                : "동의 시 표준 Curve + 원본 미리보기를 공용 학습"}
            </span>
          </div>
          <div
            className={`drop-zone ${isDragging ? "is-dragging" : ""} ${
              analysis ? "has-analysis" : ""
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            data-testid="drop-zone"
          >
            {analysis ? (
              <div className="analysis-document">
                {panelQueries.length > 1 && (
                  <div
                    className="chart-panel-tabs"
                    role="tablist"
                    aria-label={`분리된 차트 ${panelQueries.length}개`}
                    data-testid="chart-panel-tabs"
                  >
                    <span>
                      MULTI CHART · {panelQueries.length}개 분석
                      {analysis.panelSelectionTruncated
                        ? ` / ${analysis.detectedPanelCount}개 감지`
                        : ""}
                      {analysis.rejectedNonChartCount
                        ? ` / 비차트 ${analysis.rejectedNonChartCount}개 제외`
                        : ""}
                    </span>
                    <div>
                      {panelQueries.map((panelQuery, panelIndex) => (
                        <button
                          type="button"
                          role="tab"
                          id={`chart-panel-tab-${panelQuery.analysis.id}`}
                          aria-selected={panelIndex === activePanelIndex}
                          aria-controls="active-chart-panel"
                          tabIndex={
                            panelIndex === activePanelIndex ? 0 : -1
                          }
                          disabled={isSubmittingFeedback}
                          key={panelQuery.analysis.id}
                          onClick={() => selectAnalyzedPanel(panelIndex)}
                          onKeyDown={(event) => {
                            let nextIndex = panelIndex;
                            if (
                              event.key === "ArrowRight" ||
                              event.key === "ArrowDown"
                            ) {
                              nextIndex =
                                (panelIndex + 1) % panelQueries.length;
                            } else if (
                              event.key === "ArrowLeft" ||
                              event.key === "ArrowUp"
                            ) {
                              nextIndex =
                                (panelIndex - 1 + panelQueries.length) %
                                panelQueries.length;
                            } else if (event.key === "Home") {
                              nextIndex = 0;
                            } else if (event.key === "End") {
                              nextIndex = panelQueries.length - 1;
                            } else {
                              return;
                            }
                            event.preventDefault();
                            selectAnalyzedPanel(nextIndex);
                            window.requestAnimationFrame(() => {
                              document
                                .getElementById(
                                  `chart-panel-tab-${panelQueries[nextIndex].analysis.id}`,
                                )
                                ?.focus();
                            });
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={panelQuery.analysis.imageUrl}
                            alt=""
                            aria-hidden="true"
                          />
                          <span>차트 {panelIndex + 1}</span>
                          <small>
                            {panelQuery.analysis.descriptor.stateCount} State
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {panelQueries.length > 1 && (
                  <span className="visually-hidden" aria-live="polite">
                    차트 {activePanelIndex + 1}/{panelQueries.length} 선택됨
                  </span>
                )}
                <div
                  className={`analysis-preview ${
                    panelQueries.length > 1 ? "has-chart-tabs" : ""
                  }`}
                  id="active-chart-panel"
                  role={panelQueries.length > 1 ? "tabpanel" : undefined}
                  aria-labelledby={
                    panelQueries.length > 1
                      ? `chart-panel-tab-${analysis.id}`
                      : undefined
                  }
                >
                  <figure
                    className="source-panel-view"
                    data-testid="source-panel-crop"
                    aria-label={`선택된 원본 패널 크롭, 차트 ${analysis.panelIndex + 1}/${analysis.panelCount}`}
                  >
                    <figcaption className="analysis-view-label">
                      <span>선택 원본 패널</span>
                      <strong>
                        CHART {analysis.panelIndex + 1}/{analysis.panelCount}
                      </strong>
                    </figcaption>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={analysis.imageUrl}
                      alt={`업로드 이미지에서 분리한 ${analysis.fileName} 원본 패널`}
                    />
                  </figure>
                  <section
                    className="normalized-curve-view"
                    data-testid="normalized-curve-view"
                    aria-label={`차트 ${analysis.panelIndex + 1}의 정규화 Curve와 추출 근거`}
                  >
                    <header className="analysis-view-label">
                      <span>정규화 추출 Curve</span>
                      <strong>AXIS / LABEL REMOVED</strong>
                    </header>
                    <ProfileCanvas
                      profile={analysis.profile}
                      label={`축을 제거하고 표준화한 VTH Curve${
                        analysis.panelCount > 1
                          ? `, 차트 ${analysis.panelIndex + 1}/${analysis.panelCount}`
                          : ""
                      }`}
                    />
                    <dl
                      className="panel-extraction-evidence"
                      data-testid="panel-extraction-evidence"
                      aria-label={`차트 ${analysis.panelIndex + 1} 추출 근거`}
                    >
                      <div>
                        <dt>검출 State</dt>
                        <dd>{analysis.descriptor.stateCount}</dd>
                      </div>
                      <div>
                        <dt>관측 State</dt>
                        <dd>{analysis.descriptor.observedStateCount}</dd>
                      </div>
                      <div>
                        <dt>피크 / 밸리</dt>
                        <dd>
                          {analysis.descriptor.peakLocations.length} /{" "}
                          {analysis.descriptor.valleyLocations.length}
                        </dd>
                      </div>
                      <div>
                        <dt>축 방식</dt>
                        <dd>{panelAxisModeLabel(analysis.panelMode)}</dd>
                      </div>
                      <div>
                        <dt>제거 라벨</dt>
                        <dd>{analysis.removedLabelCount}개</dd>
                      </div>
                      <div>
                        <dt>Curve 검증</dt>
                        <dd>
                          {panelExtractionQuality(analysis)}
                          <small>
                            패널{" "}
                            {Math.round(analysis.panelConfidence * 100)}%
                          </small>
                        </dd>
                      </div>
                    </dl>
                  </section>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="drop-action"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  isAnalyzing || isLearning || isSubmittingFeedback
                }
              >
                <span className="upload-glyph" aria-hidden="true">
                  ↗
                </span>
                <strong>그래프를 놓거나 붙여넣으세요</strong>
                <span>클릭하여 파일 선택 · Ctrl+V / ⌘V</span>
                <small>
                  PNG · JPG · WEBP / 무작위 배치·저해상도·FHD 밀집 / 비차트 자동 제외 / 최대 30차트
                </small>
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            onChange={handleInput}
            disabled={isAnalyzing || isLearning || isSubmittingFeedback}
            className="visually-hidden"
            data-testid="file-input"
          />
          <input
            ref={batchFilesInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            multiple
            onChange={handleBatchInput}
            disabled={isAnalyzing || isLearning}
            className="visually-hidden"
            data-testid="batch-files-input"
          />
          <input
            ref={(node) => {
              batchFolderInputRef.current = node;
              if (node) {
                node.setAttribute("webkitdirectory", "");
                node.setAttribute("directory", "");
              }
            }}
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            multiple
            onChange={handleBatchInput}
            disabled={isAnalyzing || isLearning}
            className="visually-hidden"
            data-testid="batch-folder-input"
          />
          <div className="panel-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                isAnalyzing || isLearning || isSubmittingFeedback
              }
            >
              {isAnalyzing ? "형상 분석 중…" : analysis ? "다른 그래프 분석" : "그래프 선택"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void runDemo()}
              disabled={
                isAnalyzing ||
                isLearning ||
                isSubmittingFeedback ||
                !corpus
              }
              data-testid="demo-button"
            >
              랜덤 데모 그래프
            </button>
            <button
              type="button"
              className="secondary-button ppt-sample-button"
              onClick={() => void runRandomMultichartSample()}
              disabled={
                isAnalyzing ||
                isLearning ||
                isSubmittingFeedback ||
                !corpus
              }
              data-testid="random-multichart-sample-analyze"
            >
              랜덤 멀티 차트 분석
            </button>
            <div
              className="sample-download-group"
              data-testid="random-multichart-sample-downloads"
              aria-label="임의 배치 V-NAND 멀티 차트 샘플 다운로드"
            >
              {RANDOM_MULTICHART_SAMPLES.map((sample) => (
                <a
                  key={sample.url}
                  className="sample-download-button"
                  href={sample.url}
                  download={sample.fileName}
                >
                  {sample.label} ↓
                </a>
              ))}
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => batchFilesInputRef.current?.click()}
              disabled={
                isAnalyzing ||
                isLearning ||
                !sharingConsent ||
                !sharedTrainingAvailable
              }
              data-testid="batch-files-entry"
            >
              여러 파일 학습
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => batchFolderInputRef.current?.click()}
              disabled={
                isAnalyzing ||
                isLearning ||
                !sharingConsent ||
                !sharedTrainingAvailable
              }
              data-testid="batch-folder-entry"
            >
              폴더 전체 학습
            </button>
          </div>
          <label className="batch-entry-consent">
            <input
              type="checkbox"
              checked={sharingConsent}
              onChange={(event) => setSharingConsent(event.target.checked)}
              data-testid="batch-training-consent"
            />
            <span>
              {standaloneMode
                ? "일괄 학습 원본 미리보기와 Curve를 이 PC에만 저장하는 데 동의"
                : "일괄 학습 원본 미리보기와 Curve를 공용 검색 후보로 공유하는 데 동의"}
            </span>
          </label>
          {!analysis && learningStatus && (
            <p className="batch-entry-status" role="status">
              {learningStatus}
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
        </section>

        {analysis ? (
        <section className="results-section" ref={resultsRef} data-testid="results">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <span>02</span>
                ANALYSIS & RETRIEVAL
              </p>
              <h2>
                {analysis.panelSelectionTruncated
                  ? `${analysis.detectedPanelCount}개를 감지해 품질 상위 ${analysis.panelCount}개를 분석했습니다.`
                  : analysis.panelCount > 1
                    ? `${analysis.panelCount}개 차트를 좌표별로 분리했습니다.${
                        analysis.rejectedNonChartCount
                          ? ` 비차트 후보 ${analysis.rejectedNonChartCount}개는 제외했습니다.`
                          : ""
                      }`
                    : "형상 분석이 완료되었습니다."}
              </h2>
            </div>
            <div className="top-k-control" aria-label="추천 개수">
              {[5, 8, 10].map((count) => (
                <button
                  type="button"
                  key={count}
                  className={topK === count ? "active" : ""}
                  onClick={() => setTopK(count)}
                >
                  TOP {count}
                </button>
              ))}
            </div>
          </div>

          <div className="analysis-strip">
            <div>
              <span>DETECTED STATE</span>
              <strong>{analysis.descriptor.stateCount}</strong>
              <small>
                {analysis.descriptor.regularized
                  ? `관측 ${analysis.descriptor.observedStateCount} → 도메인 보정`
                  : "원시 검출과 일치"}
              </small>
            </div>
            <div>
              <span>Y SCALE</span>
              <strong>LOG₁₀</strong>
              <small>로그 축 형상으로 정규화</small>
            </div>
            <div>
              <span>FRAME</span>
              <strong>
                {analysis.panelCount > 1
                  ? `CHART ${analysis.panelIndex + 1}/${analysis.panelCount}`
                  : analysis.distributionCount > 1
                  ? `MULTI×${analysis.distributionCount}`
                  : analysis.removedLabelCount > 0
                    ? `LABEL×${analysis.removedLabelCount}`
                  : analysis.axesDetected
                    ? "REMOVED"
                    : "CLEAN"}
              </strong>
              <small>
                {analysis.panelCount > 1
                  ? `독립 패널로 분리 · ${
                      analysis.distributionCount > 1
                        ? `내부 Curve ${analysis.distributionCount}개 중 비정규성 최상 선택`
                        : "패널 내부 축·격자·라벨 별도 제거"
                    }`
                  : analysis.distributionCount > 1
                  ? `${analysis.removedLabelCount > 0 ? `라벨 ${analysis.removedLabelCount}개 제거 · ` : ""}비정규성 최상 Curve 자동 선택 · ${Math.round(analysis.irregularityScore * 100)}%`
                  : analysis.removedLabelCount > 0
                    ? "범례·주석 라벨 제거 후 Curve 복원"
                  : analysis.axesDetected
                    ? "축·프레임 자동 검출"
                    : "Curve 영역 직접 검출"}
              </small>
            </div>
            <div>
              <span>ANALYSIS LATENCY</span>
              <strong>{Math.max(1, Math.round(analysis.processingMs))}ms</strong>
              <small>
                {standaloneMode
                  ? "원본에서 형상 추출 · 이 PC에서만 학습"
                  : "원본에서 형상 추출 · 동의 시 공용 학습"}
              </small>
            </div>
          </div>

          <details className="compact-drawer learning-drawer">
            <summary>
              <span>INCREMENTAL LEARNING</span>
              <small>
                {standaloneMode
                  ? `이 PC 후보 ${sharedCandidateCount}개 · 외부 통신 없음`
                  : `공용 후보 ${sharedCandidateCount}개 · 동의 후 등록`}
              </small>
            </summary>
          <div className="learning-tabs" role="tablist" aria-label="학습 데이터">
            <button
              type="button"
              role="tab"
              aria-selected={learningTab === "register"}
              className={learningTab === "register" ? "is-active" : ""}
              onClick={() => setLearningTab("register")}
              data-testid="learning-tab-register"
            >
              학습 등록
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={learningTab === "manage"}
              className={learningTab === "manage" ? "is-active" : ""}
              onClick={() => setLearningTab("manage")}
              data-testid="learning-tab-manage"
            >
              데이터 관리
              <span>{learnedCandidates.length}</span>
            </button>
          </div>
          {learningTab === "register" ? (
          <div className="learning-toolbar" data-testid="learning-toolbar">
            <div className="learning-summary">
              <strong>INCREMENTAL LEARNING</strong>
              <span>
                {standaloneMode ? "이 PC 학습 후보" : "공용 학습 후보"}{" "}
                {sharedCandidateCount}개 ·{" "}
                {standaloneMode
                  ? sharedTrainingAvailable
                    ? "LOCAL STORE 준비됨"
                    : "LOCAL STORE 대기"
                  : sharedTrainingAvailable
                    ? "SHARED API 연결됨"
                    : "SHARED API 대기"}
              </span>
              <small>
                {standaloneMode ? (
                  <>
                    축 없는 표준 Curve와 메타데이터를 제거한 원본 미리보기를
                    패키지의 data 폴더에만 저장합니다. 인터넷이나 dove9999.com으로
                    전송하지 않습니다. 선택한 여러 파일 또는 폴더 안의 지원
                    이미지를 빠짐없이 순차 학습하며, 한 이미지에서 좌표별로
                    분리한 차트는 각각 독립 후보로 저장합니다.
                  </>
                ) : (
                  <>
                    축 없는 표준 Curve, 특징, 메타데이터를 제거한 원본 미리보기를
                    저장하고 전체 후보를 page 단위로 불러옵니다. 등록 직후 다른
                    사용자에게도 검색 후보로 노출되며 추천 카드에 원본이 함께
                    표시됩니다. 선택한 여러 파일 또는 폴더 안의 지원 이미지를
                    빠짐없이 순차 학습하며, 한 이미지에서 좌표별로 분리한
                    차트는 각각 독립 후보로 저장합니다.
                    모델 가중치는 복수 전문가 합의와 회귀 게이트를 통과한 뒤에만
                    갱신됩니다.{" "}
                    <a
                      href="/shared-training-openapi.json"
                      target="_blank"
                      rel="noreferrer"
                    >
                      공용 API 문서
                    </a>
                  </>
                )}
              </small>
            </div>
            <label htmlFor="training-label">
              <span>학습 라벨</span>
              <input
                id="training-label"
                value={trainingLabel}
                onChange={(event) => setTrainingLabel(event.target.value)}
                maxLength={120}
                autoComplete="off"
              />
            </label>
            <label className="sharing-consent">
              <input
                type="checkbox"
                checked={sharingConsent}
                onChange={(event) => setSharingConsent(event.target.checked)}
                data-testid="shared-training-consent"
              />
              <span>
                {standaloneMode
                  ? "파일명·메타데이터를 제외한 원본 미리보기와 표준 Curve를 이 PC에만 저장하는 데 동의합니다."
                  : "파일명·메타데이터를 제외한 원본 미리보기, 표준 Curve와 라벨을 공용 검색 후보로 공유하는 데 동의합니다."}
              </span>
            </label>
            <div className="learning-actions">
              <button
                type="button"
                onClick={() => void learnCurrentImage()}
                disabled={
                  isAnalyzing ||
                  isLearning ||
                  !sharingConsent ||
                  !sharedTrainingAvailable
                }
                data-testid="learn-current-image"
              >
                {isLearning
                  ? "학습 처리 중…"
                  : analysis.panelCount > 1
                    ? standaloneMode
                      ? `분리 차트 ${analysis.panelCount}개 모두 학습`
                      : `분리 차트 ${analysis.panelCount}개 모두 공용 등록`
                    : standaloneMode
                      ? "현재 그림 학습"
                      : "현재 그림 공용 등록"}
              </button>
              <button
                type="button"
                onClick={() => batchFilesInputRef.current?.click()}
                disabled={
                  isAnalyzing ||
                  isLearning ||
                  !sharingConsent ||
                  !sharedTrainingAvailable
                }
                data-testid="learn-multiple-files"
              >
                여러 파일 학습
              </button>
              <button
                type="button"
                onClick={() => batchFolderInputRef.current?.click()}
                disabled={
                  isAnalyzing ||
                  isLearning ||
                  !sharingConsent ||
                  !sharedTrainingAvailable
                }
                data-testid="learn-folder"
              >
                폴더 전체 학습
              </button>
            </div>
            {learningStatus && <p role="status">{learningStatus}</p>}
          </div>
          ) : (
          <section
            className="learning-management"
            aria-label="학습 데이터 관리"
            data-testid="learning-data-management"
          >
            <div className="learning-management-header">
              <div>
                <strong>학습된 데이터 목록</strong>
                <span>
                  전체 {learnedCandidates.length}개 · 삭제 가능{" "}
                  {deletableCandidateIds.length}개
                </span>
                <small>
                  {standaloneMode
                    ? "이 PC에 저장된 학습 데이터를 조회하고 선택 삭제합니다."
                    : "전체 공용 후보를 조회합니다. 이 브라우저에서 등록한 항목만 삭제할 수 있습니다."}
                </small>
              </div>
              <label htmlFor="learned-data-filter">
                <span>목록 검색</span>
                <input
                  id="learned-data-filter"
                  type="search"
                  value={managementQuery}
                  onChange={(event) => {
                    setManagementQuery(event.target.value);
                    setManagementPage(0);
                  }}
                  placeholder="라벨, ID, State"
                  data-testid="learned-data-filter"
                />
              </label>
            </div>
            <div className="learning-management-actions">
              <button
                type="button"
                onClick={toggleAllFilteredDeletableCandidates}
                disabled={
                  !filteredDeletableCandidateIds.length ||
                  isDeletingLearnedCandidates
                }
                aria-pressed={allFilteredDeletableSelected}
                data-testid="learned-select-all"
              >
                {allFilteredDeletableSelected
                  ? "검색 결과 선택 해제"
                  : "삭제 가능 전체 선택"}
              </button>
              <span>{effectiveSelectedCandidateIds.length}개 선택됨</span>
              <button
                type="button"
                className="danger-action"
                onClick={() => setDeleteConfirmationOpen(true)}
                disabled={
                  !effectiveSelectedCandidateIds.length ||
                  isDeletingLearnedCandidates
                }
                data-testid="delete-selected-learned"
              >
                {isDeletingLearnedCandidates ? "삭제 중…" : "선택 삭제"}
              </button>
            </div>
            {deleteConfirmationOpen && (
              <div
                className="learning-delete-confirmation"
                role="alert"
                data-testid="learned-delete-confirmation"
              >
                <p>
                  선택한 {effectiveSelectedCandidateIds.length}개 학습 데이터를
                  삭제할까요? 삭제 후 검색 후보에서 즉시 제외됩니다.
                </p>
                <button
                  type="button"
                  onClick={() => void deleteSelectedLearnedCandidates()}
                  data-testid="confirm-delete-selected-learned"
                >
                  삭제 확정
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmationOpen(false)}
                >
                  취소
                </button>
              </div>
            )}
            <div className="learned-data-list" data-testid="learned-data-list">
              {!visibleManagedCandidates.length ? (
                <p className="learning-empty">
                  {learnedCandidates.length
                    ? "검색 조건에 맞는 학습 데이터가 없습니다."
                    : "학습된 데이터가 없습니다."}
                </p>
              ) : (
                visibleManagedCandidates.map((candidate) => (
                  <article
                    className={`learned-data-row ${
                      selectedCandidateIdSet.has(candidate.id)
                        ? "is-selected"
                        : ""
                    }`}
                    key={candidate.id}
                  >
                    <label className="learned-data-select">
                      <input
                        type="checkbox"
                        checked={selectedCandidateIdSet.has(candidate.id)}
                        disabled={
                          !candidate.canDelete || isDeletingLearnedCandidates
                        }
                        onChange={() =>
                          toggleLearnedCandidateSelection(candidate.id)
                        }
                        aria-label={`${candidate.label} 삭제 선택`}
                        data-testid={`select-learned-${candidate.id}`}
                      />
                    </label>
                    <button
                      type="button"
                      className="learned-data-preview"
                      onClick={() =>
                        setExpandedImage({
                          src: candidate.sourceImage || candidate.image,
                          alt: `${candidate.label} 학습 그래프`,
                          label: `${candidate.label} · 학습 데이터`,
                        })
                      }
                      aria-label={`${candidate.label} 원본 크기로 확대`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={candidate.sourceImage || candidate.image}
                        alt={`${candidate.label} 학습 그래프`}
                      />
                      <span aria-hidden="true">↗</span>
                    </button>
                    <div className="learned-data-info">
                      <strong>{candidate.label}</strong>
                      <span>{candidate.id}</span>
                      <small>
                        {candidate.stateCount}-STATE ·{" "}
                        {formatLearnedAt(candidate.learnedAt)}
                      </small>
                    </div>
                    <div className="learned-data-access">
                      <span>
                        {standaloneMode ? "LOCAL" : "SHARED"}
                      </span>
                      <small>
                        {candidate.canDelete
                          ? "삭제 가능"
                          : "조회 전용 · 등록 브라우저에서 삭제"}
                      </small>
                    </div>
                  </article>
                ))
              )}
            </div>
            <div className="learning-management-pagination">
              <button
                type="button"
                onClick={() =>
                  setManagementPage(Math.max(0, safeManagementPage - 1))
                }
                disabled={safeManagementPage === 0}
              >
                이전
              </button>
              <span>
                {safeManagementPage + 1} / {managementPageCount}
              </span>
              <button
                type="button"
                onClick={() =>
                  setManagementPage(
                    Math.min(
                      managementPageCount - 1,
                      safeManagementPage + 1,
                    ),
                  )
                }
                disabled={safeManagementPage >= managementPageCount - 1}
              >
                다음
              </button>
            </div>
            {learningStatus && <p role="status">{learningStatus}</p>}
          </section>
          )}
          </details>

          <details className="compact-drawer feedback-drawer">
            <summary>
              <span>EXPERT RELEVANCE</span>
              <small>
                {feedbackCount
                  ? `${feedbackCount}개 평가됨`
                  : "결과별 유사/비유사 판정"}
              </small>
            </summary>
          <div className="feedback-toolbar">
            <div className="feedback-summary">
              <strong>EXPERT RELEVANCE</strong>
              <span>
                {feedbackCount
                  ? `${feedbackCount}개 후보 평가됨`
                  : "추천 결과를 유사/비유사로 표시해 주세요"}
              </span>
              <small>
                {standaloneMode ? (
                  <>판정은 JSON으로 이 PC에만 저장할 수 있습니다.</>
                ) : (
                  <>
                    공용 report {sharedRelevanceStats.reports}개 · 판정{" "}
                    {sharedRelevanceStats.judgments}개 · 합의 준비 Query{" "}
                    {sharedRelevanceStats.consensusReadyQueries}개
                  </>
                )}
              </small>
            </div>
            {!standaloneMode && <div className="feedback-session">
              <div className="feedback-session-fields">
                <label htmlFor="feedback-query-code">
                  <span>공유 Query 코드</span>
                  <input
                    id="feedback-query-code"
                    value={queryCode}
                    onChange={(event) => setQueryCode(event.target.value)}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="feedback-query-help"
                  />
                </label>
                <label htmlFor="feedback-annotator-code">
                  <span>익명 평가자 코드</span>
                  <input
                    id="feedback-annotator-code"
                    value={annotatorCode}
                    onChange={(event) => setAnnotatorCode(event.target.value)}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="기기별 자동 생성"
                    aria-describedby="feedback-query-help"
                  />
                </label>
              </div>
              <small id="feedback-query-help">
                같은 그림은 같은 Query 코드, 평가자는 서로 다른 익명 코드를 사용하세요.
              </small>
            </div>}
            {!standaloneMode && <label className="feedback-sharing-consent">
              <input
                type="checkbox"
                checked={feedbackSharingConsent}
                onChange={(event) =>
                  setFeedbackSharingConsent(event.target.checked)
                }
                data-testid="shared-relevance-consent"
              />
              <span>
                원본·파일명 없이 표준 Curve와 익명 판정을 공용 재학습 데이터로
                공유하는 데 동의합니다.
              </span>
            </label>}
            <div className="feedback-actions">
              <button
                type="button"
                onClick={exportFeedback}
                disabled={!feedbackCount}
                data-testid="feedback-export"
              >
                평가 JSON 저장
              </button>
              {!standaloneMode && <button
                type="button"
                onClick={() => void submitSharedFeedback()}
                disabled={
                  !feedbackCount ||
                  !feedbackSharingConsent ||
                  !sharedRelevanceAvailable ||
                  isSubmittingFeedback
                }
                data-testid="shared-relevance-submit"
              >
                {isSubmittingFeedback ? "공용 제출 중…" : "공용 학습 라벨 제출"}
              </button>}
              {!standaloneMode && submittedFeedbackReportId && (
                <button
                  type="button"
                  className="feedback-delete"
                  onClick={() => void removeSubmittedFeedback()}
                  data-testid="shared-relevance-delete"
                >
                  공용 판정 삭제
                </button>
              )}
            </div>
            {feedbackSubmissionStatus && (
              <p role="status">{feedbackSubmissionStatus}</p>
            )}
          </div>
          </details>

          <div className="results-list">
            {visibleResults.map((result) => (
              <article className="result-card" key={result.id}>
                <div className="rank-box">
                  <span>RANK</span>
                  <strong>{String(result.rank).padStart(2, "0")}</strong>
                </div>
                <div
                  className={`result-image ${
                    result.sourceImage ? "has-source-image" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="result-thumbnail"
                    onClick={() =>
                      setExpandedImage({
                        src: result.image,
                        alt: `${result.label} 표준 VTH Curve`,
                        label: `${result.label} · 표준 Curve`,
                      })
                    }
                    aria-label={`${result.label} 표준 VTH Curve 원본 크기로 확대`}
                    data-testid={`expand-image-${result.id}-standard`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={result.image} alt={`${result.label} 표준 VTH Curve`} />
                    {result.sourceImage && <small>표준 CURVE</small>}
                    <span className="thumbnail-zoom-hint" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                  {result.sourceImage && (
                    <button
                      type="button"
                      className="result-thumbnail source-thumbnail"
                      onClick={() =>
                        setExpandedImage({
                          src: result.sourceImage!,
                          alt: `${result.label} 학습 원본 그래프`,
                          label: `${result.label} · 학습 원본`,
                        })
                      }
                      aria-label={`${result.label} 학습 원본 그래프 원본 크기로 확대`}
                      data-testid={`expand-image-${result.id}-source`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={result.sourceImage}
                        alt={`${result.label} 학습 원본 그래프`}
                      />
                      <small>학습 원본</small>
                      <span className="thumbnail-zoom-hint" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  )}
                  <span>{result.stateCount}-STATE</span>
                </div>
                <div className="result-main">
                  <div className="result-title-row">
                    <div>
                      <span className="sample-id">{result.id}</span>
                      <h3>{result.label}</h3>
                    </div>
                    <div className="match-score">
                      <strong>{(result.score * 100).toFixed(1)}</strong>
                      <span>% MATCH</span>
                    </div>
                  </div>
                  <div className="result-tags">
                    <span>{familyLabel[result.family] ?? result.family}</span>
                    {result.shared && <span>공용 학습 후보</span>}
                    {result.learned && !result.shared && (
                      <span>이 PC 학습 후보</span>
                    )}
                    <span>Curve {(result.curveScore * 100).toFixed(0)}%</span>
                    <span>
                      Peak–Valley {(result.peakValleyScore * 100).toFixed(0)}%
                    </span>
                    <span>Position {(result.locationScore * 100).toFixed(0)}%</span>
                    {result.modelScore !== null && (
                      <span>Reranker {(result.modelScore * 100).toFixed(0)}%</span>
                    )}
                    {result.dualEncoderScore !== undefined && (
                      <span>
                        Learned Shape{" "}
                        {(result.dualEncoderScore * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <ul>
                    {result.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <div
                    className="relevance-control"
                    role="group"
                    aria-label={`${result.label} 유사도 평가`}
                  >
                    <span>이 추천은?</span>
                    <button
                      type="button"
                      className={
                        feedback[result.id] === "similar" ? "is-selected" : ""
                      }
                      aria-pressed={feedback[result.id] === "similar"}
                      onClick={() => toggleFeedback(result.id, "similar")}
                      data-testid={`feedback-similar-${result.id}`}
                    >
                      유사
                    </button>
                    <button
                      type="button"
                      className={
                        feedback[result.id] === "dissimilar" ? "is-selected" : ""
                      }
                      aria-pressed={feedback[result.id] === "dissimilar"}
                      onClick={() => toggleFeedback(result.id, "dissimilar")}
                      data-testid={`feedback-dissimilar-${result.id}`}
                    >
                      비유사
                    </button>
                    {result.canDelete && (
                      <button
                        type="button"
                        onClick={() => void removeLearnedCandidate(result.id)}
                        data-testid={`delete-learned-${result.id}`}
                      >
                        학습 삭제
                      </button>
                    )}
                  </div>
                </div>
                <div className="score-rail" aria-hidden="true">
                  <span style={{ height: `${clamp(result.score) * 100}%` }} />
                </div>
              </article>
            ))}
          </div>
        </section>
        ) : (
        <section className="method-section">
          <div className="section-index">02 / METHOD</div>
          <div className="method-grid">
            <article>
              <span>01</span>
              <h2>프레임 정규화</h2>
              <p>분포 파형만 찾아 텍스트, 표, 빈 좌표계와 설명 도형을 제외한 뒤 축·격자·기울기를 제거합니다.</p>
            </article>
            <article>
              <span>02</span>
              <h2>로그 Curve 복원</h2>
              <p>State 봉우리와 valley, 양쪽 tail 기울기를 256-point 형상으로 바꿉니다.</p>
            </article>
            <article>
              <span>03</span>
              <h2>형상 재정렬</h2>
              <p>원본 수치 Curve와 정렬 비교하고 가장 가까운 분포와 이유를 제시합니다.</p>
            </article>
          </div>
        </section>
        )}
      </div>

      {expandedImage && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${expandedImage.label} 원본 크기 보기`}
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setExpandedImage(null);
            }
          }}
          data-testid="image-lightbox"
        >
          <div className="image-lightbox-panel">
            <div className="image-lightbox-header">
              <div>
                <span>ORIGINAL SIZE</span>
                <strong>{expandedImage.label}</strong>
              </div>
              <button
                type="button"
                onClick={() => setExpandedImage(null)}
                autoFocus
                aria-label="확대 이미지 닫기"
                data-testid="image-lightbox-close"
              >
                닫기 <kbd>ESC</kbd>
              </button>
            </div>
            <div className="image-lightbox-canvas">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={expandedImage.src} alt={expandedImage.alt} />
            </div>
          </div>
        </div>
      )}

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>유사 산포 검색</span>
        </div>
        <p>Shape-first retrieval for log-scale V-NAND distributions.</p>
        <span>ENGINE V3.5 / WAVEFORM-ONLY · 2·4·8·16-STATE · 30-PANEL MAX</span>
      </footer>
    </main>
  );
}
