import type { ReviewPreset, ReviewLens } from "./types.js";

/** Build a lens. The expertise prefix ("You're a top 1% ...") is prepended
 *  at prompt-build time, so the role is just the discipline. */
function lens(id: string, emoji: string, label: string, role: string): ReviewLens {
  return { id, emoji, label, role };
}

export const REVIEW_PRESETS: ReviewPreset[] = [
  // --- Smoke test -----------------------------------------------------------
  {
    id: "smoke-test",
    name: "Smoke Test",
    description: "2 lenses, fast sanity check. Verifies the pipeline works end-to-end before a full run.",
    smokeTest: true,
    lenses: [
      lens("generalist", "🔍", "Generalist Engineer", "senior software engineer"),
      lens("security", "🔐", "Security Reviewer", "application security engineer"),
    ],
  },
  // --- Trading bot (the user's original example) ---------------------------
  {
    id: "trading-bot",
    name: "Trading Bot",
    description: "12 specialists for a systematic trading project.",
    lenses: [
      lens("quant", "📊", "Quant Researcher", "quant researcher"),
      lens("ml", "🧠", "ML/AI Researcher", "ML/AI researcher"),
      lens("systems", "💻", "Trading Systems Engineer", "trading systems engineer"),
      lens("risk", "🛡️", "Risk & Portfolio Manager", "risk manager and portfolio manager"),
      lens("microstructure", "⚡", "Market Microstructure Specialist", "market microstructure specialist"),
      lens("data", "🔬", "Data Scientist", "data scientist"),
      lens("stats", "📐", "Statistician", "statistician"),
      lens("compliance", "🔐", "Security, Compliance & Tax Specialist", "security, compliance and tax specialist"),
      lens("backtesting", "🏭", "Backtesting & Research Engineering Specialist", "backtesting and research engineering specialist"),
      lens("sre", "⚙️", "Platform & SRE", "platform and site reliability engineer"),
      lens("dsa", "🧮", "DSA Engineer", "DSA engineer for numerical simulation"),
      lens("trader", "📈", "Professional Systematic Trader", "systematic trader who has traded through multiple crypto regimes"),
    ],
  },
  // --- General software -----------------------------------------------------
  {
    id: "general-software",
    name: "General Software",
    description: "8 specialists for any software project.",
    lenses: [
      lens("architecture", "🏛️", "Software Architect", "software architect"),
      lens("backend", "🔧", "Backend Engineer", "backend engineer"),
      lens("frontend", "🎨", "Frontend Engineer", "frontend engineer"),
      lens("security", "🔐", "Security Engineer", "application security engineer"),
      lens("performance", "⚡", "Performance Engineer", "performance engineer"),
      lens("testing", "🧪", "Testing / QA Engineer", "testing and QA engineer"),
      lens("devops", "🚀", "DevOps / SRE", "devops and site reliability engineer"),
      lens("a11y", "♿", "Accessibility Specialist", "accessibility specialist"),
    ],
  },
  // --- ML project -----------------------------------------------------------
  {
    id: "ml-project",
    name: "ML Project",
    description: "7 specialists for an ML/AI project.",
    lenses: [
      lens("ml", "🧠", "ML/AI Researcher", "ML/AI researcher"),
      lens("data", "🔬", "Data Scientist", "data scientist"),
      lens("mlops", "🛠️", "MLOps Engineer", "MLOps engineer"),
      lens("stats", "📐", "Statistician", "statistician"),
      lens("eval", "📏", "Evaluation & Metrics Specialist", "ML evaluation and metrics specialist"),
      lens("ethics", "⚖️", "AI Ethics & Safety Specialist", "AI ethics and safety specialist"),
      lens("software", "💻", "Software Engineer", "software engineer"),
    ],
  },
  // --- Web app / SaaS -------------------------------------------------------
  {
    id: "web-app",
    name: "Web App / SaaS",
    description: "7 specialists for a SaaS / web application.",
    lenses: [
      lens("architecture", "🏛️", "Software Architect", "software architect for web applications"),
      lens("backend", "🔧", "Backend Engineer", "backend engineer"),
      lens("frontend", "🎨", "Frontend Engineer", "frontend engineer"),
      lens("security", "ð", "Security Engineer", "application security engineer"),
      lens("performance", "⚡", "Performance Engineer", "web performance engineer"),
      lens("testing", "🧪", "Testing / QA Engineer", "testing and QA engineer"),
      lens("devops", "ð", "DevOps / SRE", "devops and site reliability engineer"),
    ],
  },
  // --- Blog / content site --------------------------------------------------
  {
    id: "web-blog",
    name: "Blog / Content Site",
    description: "5 specialists for a blog or content-driven website.",
    lenses: [
      lens("frontend", "ð¨", "Frontend Engineer", "frontend engineer specializing in content sites"),
      lens("seo", "ð", "SEO Specialist", "SEO and structured-data specialist"),
      lens("performance", "⚡", "Performance Engineer", "web performance engineer (Core Web Vitals)"),
      lens("a11y", "♿", "Accessibility Specialist", "accessibility specialist"),
      lens("security", "ð", "Security Engineer", "application security engineer"),
    ],
  },
  // --- API / backend service ------------------------------------------------
  {
    id: "api-service",
    name: "API / Backend Service",
    description: "5 specialists for a REST/GraphQL API or microservice.",
    lenses: [
      lens("architecture", "🏛️", "Software Architect", "software architect for API services"),
      lens("backend", "🔧", "Backend Engineer", "backend engineer"),
      lens("security", "🔐", "Security Engineer", "API security engineer"),
      lens("testing", "🧪", "Testing / QA Engineer", "testing and QA engineer"),
      lens("devops", "🚀", "DevOps / SRE", "devops and site reliability engineer"),
    ],
  },
  // --- Mobile app -----------------------------------------------------------
  {
    id: "mobile-app",
    name: "Mobile App",
    description: "5 specialists for a mobile app.",
    lenses: [
      lens("mobile", "📱", "Mobile Engineer", "mobile engineer (iOS/Android)"),
      lens("ux", "✨", "UX Engineer", "UX engineer focused on mobile interactions"),
      lens("performance", "⚡", "Performance Engineer", "mobile performance engineer"),
      lens("security", "🔐", "Security Engineer", "mobile security engineer"),
      lens("testing", "🧪", "Testing / QA Engineer", "mobile testing and QA engineer"),
    ],
  },
  // --- Game / interactive ---------------------------------------------------
  {
    id: "game-dev",
    name: "Game / Interactive",
    description: "5 specialists for a game or interactive app.",
    lenses: [
      lens("gameplay", "🎮", "Gameplay Engineer", "gameplay engineer"),
      lens("graphics", "🖼️", "Graphics Engineer", "graphics/rendering engineer"),
      lens("performance", "⚡", "Performance Engineer", "game performance engineer (frame budget)"),
      lens("audio", "🔊", "Audio Engineer", "game audio engineer"),
      lens("testing", "🧪", "Testing / QA Engineer", "game testing and QA engineer"),
    ],
  },
];

export function getPreset(id: string): ReviewPreset | undefined {
  return REVIEW_PRESETS.find((p) => p.id === id);
}
