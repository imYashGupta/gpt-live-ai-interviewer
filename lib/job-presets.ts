export interface JobPreset {
  id: string;
  label: string;
  role: string;
  jobDescription: string;
  candidateNotes: string;
}

export const JOB_PRESETS: JobPreset[] = [
  {
    id: "laravel",
    label: "Laravel Backend",
    role: "Senior Laravel Developer",
    jobDescription:
      "Lead backend development with PHP and Laravel. Design reliable APIs and relational data models, operate queue-based workloads, debug production issues, and communicate architecture trade-offs clearly.",
    candidateNotes:
      "Focus areas: PHP / Laravel, SQL and database design, queues, APIs, debugging, architecture, and communication.",
  },
  {
    id: "react-next",
    label: "React / Next.js",
    role: "Senior React / Next.js Engineer",
    jobDescription:
      "Build and maintain product surfaces in React and Next.js. Own component architecture and the server/client boundary, style with Tailwind CSS, keep bundles and Core Web Vitals healthy, and integrate typed APIs end to end.",
    candidateNotes:
      "Focus areas: React, Next.js App Router, TypeScript, Tailwind CSS, state management, rendering strategies, performance, and testing.",
  },
  {
    id: "vue-nuxt",
    label: "Vue / Nuxt",
    role: "Vue.js Frontend Developer",
    jobDescription:
      "Develop customer-facing interfaces with Vue 3 and Nuxt. Compose reusable components with the Composition API, manage shared state with Pinia, style with Tailwind CSS, and keep pages fast and accessible.",
    candidateNotes:
      "Focus areas: Vue 3 Composition API, Nuxt, Pinia, Tailwind CSS, reactivity, routing, accessibility, and component testing.",
  },
  {
    id: "node-fullstack",
    label: "Full-stack Node",
    role: "Full-Stack Node.js Engineer",
    jobDescription:
      "Ship features across a TypeScript stack. Design REST and GraphQL endpoints on Node.js, model data in PostgreSQL, handle background jobs and caching, and wire it all to a React front end.",
    candidateNotes:
      "Focus areas: Node.js, TypeScript, API design, PostgreSQL, caching, async patterns, testing, and deployment.",
  },
  {
    id: "python-django",
    label: "Python / Django",
    role: "Python / Django Backend Engineer",
    jobDescription:
      "Build and operate Django services. Design relational schemas and migrations, write efficient ORM queries, expose APIs with Django REST Framework, and keep Celery workloads reliable in production.",
    candidateNotes:
      "Focus areas: Python, Django, Django REST Framework, ORM and query performance, Celery, testing, and debugging.",
  },
  {
    id: "devops",
    label: "DevOps / Cloud",
    role: "DevOps / Cloud Engineer",
    jobDescription:
      "Own infrastructure and delivery pipelines. Provision cloud resources as code, run containerized workloads, keep CI/CD fast and safe, and lead incident response backed by solid observability.",
    candidateNotes:
      "Focus areas: AWS, Terraform, Docker, Kubernetes, CI/CD, monitoring and alerting, incident response, and cost control.",
  },
  {
    id: "react-native",
    label: "React Native",
    role: "React Native Mobile Engineer",
    jobDescription:
      "Build cross-platform mobile apps with React Native. Own navigation and offline state, bridge native modules when needed, tune list and animation performance, and manage App Store and Play releases.",
    candidateNotes:
      "Focus areas: React Native, TypeScript, navigation, offline storage, native modules, performance profiling, and release workflows.",
  },
  {
    id: "seo",
    label: "SEO Specialist",
    role: "SEO Specialist",
    jobDescription:
      "Grow organic traffic across the site. Run technical audits, plan keyword and content strategy, fix crawl and indexation issues, build internal linking, and report on rankings and conversions.",
    candidateNotes:
      "Focus areas: technical SEO, keyword research, on-page optimization, Core Web Vitals, link building, Search Console, and analytics.",
  },
  {
    id: "content-writer",
    label: "Content Writer",
    role: "Content Writer",
    jobDescription:
      "Write and edit content that ranks and converts. Research topics and audiences, produce long-form articles and product copy, work to a style guide, and partner with SEO and design on distribution.",
    candidateNotes:
      "Focus areas: research, structure and storytelling, editing, SEO writing, brand voice, working from briefs, and measuring content performance.",
  },
  {
    id: "sales",
    label: "Sales Development",
    role: "Sales Development Representative",
    jobDescription:
      "Open pipeline for the sales team. Research and qualify accounts, run multi-channel outbound, handle objections on discovery calls, and keep the CRM clean while hitting meeting targets.",
    candidateNotes:
      "Focus areas: prospecting, qualification frameworks, cold outreach, objection handling, discovery calls, CRM hygiene, and pipeline metrics.",
  },
];

export const DEFAULT_JOB_PRESET = JOB_PRESETS[0];

export function findMatchingPreset(config: {
  role: string;
  jobDescription: string;
  candidateNotes: string;
}) {
  return (
    JOB_PRESETS.find(
      (preset) =>
        preset.role === config.role &&
        preset.jobDescription === config.jobDescription &&
        preset.candidateNotes === config.candidateNotes,
    ) ?? null
  );
}
