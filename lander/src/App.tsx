import { useState, useRef, useMemo } from 'react';
import { Terminal, Code2, GitBranch, Infinity, ArrowRight, CornerRightDown, Copy, Check, Wrench, Globe, GitFork, Cpu, Layers, RefreshCw, Brain, Puzzle } from 'lucide-react';
import { Button } from './components/Button';
import './index.css';

const coreCode = `type Form =
  | { tag: "think"; input: string }
  | { tag: "tool"; name: string; args: Record<string, any> }
  | { tag: "seq"; forms: Form[] }
  | { tag: "done"; summary: string };

// The loop:
function step(world: World, form: Form): Form {
  switch (form.tag) {
    case "think":    return think(world, form.input);
    case "tool":     return invokeTool(world, form);
    case "seq":      return seq(world, form.forms);
    case "done":     return form;
  }
}

// eval = repeat(step) until done
`;

const models = [
  "arcee-ai/trinity-large-preview:free",
  "minimax/minimax-m2.5",
  "google/gemini-3-flash-preview",
  "deepseek/deepseek-v3.2",
  "stepfun/step-3.5-flash:free",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "moonshotai/kimi-k2.5",
  "x-ai/grok-4.1-fast",
  "google/gemini-2.5-flash",
];

function buildLoopExample(model: string) {
  return `import { AgentLoop, OpenRouterProvider, primitiveTools } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider(),
  model: "${model}",
  system: "You are a deploy bot.",
  // primitiveTools() = file I/O, shell, memory
  tools: [
    ...primitiveTools(),
    {
      name: "Deploy",
      description: "Deploy the app",
      arguments: [
        { name: "env", description: "target" },
      ],
      execute: async (args) =>
        "Deployed to " + args.env,
    },
  ],
});

agent.on("stream_chunk", (e) => process.stdout.write(e.text));

await agent.sendSync("Deploy to staging");
await agent.stop();
`;
}

// Simple token-based syntax highlighter that doesn't break itself
function highlightCode(code: string): string {
  const lines = code.split('\n');
  
  return lines.map(line => {
    // Handle comments first - entire line after //
    if (line.includes('//')) {
      const idx = line.indexOf('//');
      const before = line.slice(0, idx);
      const comment = line.slice(idx);
      return highlightLine(before) + `<span class="code-comment">${escapeHtml(comment)}</span>`;
    }
    return highlightLine(line);
  }).join('\n');
}

function escapeHtml(str: string): string {
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightLine(line: string): string {
  let result = '';
  let i = 0;
  
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== '"') end++;
      const str = line.slice(i, end + 1);
      result += `<span class="code-string">${escapeHtml(str)}</span>`;
      i = end + 1;
      continue;
    }
    
    if (/[a-zA-Z_]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) end++;
      const word = line.slice(i, end);
      
      if (['type', 'function', 'switch', 'case', 'return', 'import', 'from', 'const', 'new', 'await', 'async', 'export'].includes(word)) {
        result += `<span class="code-keyword">${word}</span>`;
      } else if (['Form', 'World', 'Record', 'string', 'any', 'AgentLoop', 'OpenRouterProvider', 'primitiveTools'].includes(word)) {
        result += `<span class="code-type">${word}</span>`;
      } else {
        result += `<span class="code-ident">${word}</span>`;
      }
      i = end;
      continue;
    }
    
    result += escapeHtml(line[i]);
    i++;
  }
  
  return result;
}

const formattedCode = highlightCode(coreCode);

const features = [
  {
    icon: Layers,
    title: 'Agent Harness',
    description: 'Not just an agent — a framework for building agents. Swap models, tools, memory, and behavior without forking.',
  },
  {
    icon: Globe,
    title: 'Any Model',
    description: 'Claude, Gemini, Grok, DeepSeek, Llama — use whichever model you want via OpenRouter. Just pass the name.',
  },
  {
    icon: RefreshCw,
    title: 'Hot Reload',
    description: 'Build tools on the fly. Agent writes a .ts file, calls Reload, and uses the new tool immediately — no restart needed.',
  },
  {
    icon: GitBranch,
    title: 'Self-Modifying',
    description: 'Gloop can edit its own source, fix its own bugs, and restart itself. Tell it what you want changed.',
  },
  {
    icon: Puzzle,
    title: 'Fully Hackable',
    description: 'Inject custom tools, override memory backends, add skills, change the UI. Your harness, your rules.',
  },
  {
    icon: Infinity,
    title: 'Pure Data Core',
    description: 'Everything is data. No hidden state. The interpreter evaluates Forms recursively — testable, composable, transparent.',
  },
];

const whyGloop = [
  { q: 'Try alternative tool formats', a: 'Git patches? Marked inserts? Test what works best for token spend vs performance.' },
  { q: 'Hot-reload self-built tools', a: 'Let the agent write tools and reload them into context without restarting.' },
  { q: 'Self-modification + session resume', a: 'Agent modifies its own harness and restarts without losing context.' },
  { q: 'Experiment with memory', a: 'Start with markdown, swap to embeddings, graphs, or SQLite later.' },
  { q: 'Per-project replication', a: 'Clone gloop into a project with custom config and tools. Does specialization help?' },
];

const marqueeItems = [
  'OPEN HARNESS',
  'ANY MODEL',
  'SELF-MODIFYING',
  'HOT RELOAD',
  'PURE DATA',
  'HACKABLE',
  'RECURSIVE',
  'COMPOSABLE'
];

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <div className="bg-foreground text-background font-mono text-sm p-4 pr-14 border-4 border-foreground overflow-x-auto">
        <span className="text-accent mr-2">$</span>
        {text}
      </div>
      <button
        onClick={handleCopy}
        className="absolute top-1/2 -translate-y-1/2 right-3 p-2 text-background/60 hover:text-[#F0B323] transition-colors cursor-pointer"
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="w-5 h-5 text-[#F0B323]" /> : <Copy className="w-5 h-5" />}
      </button>
    </div>
  );
}

function InfoRow({ icon: Icon, title, text }: { icon: React.ElementType; title: string; text: React.ReactNode }) {
  return (
    <div className="flex gap-4 items-start">
      <div className="p-2 border-2 border-background/30 shrink-0 mt-0.5">
        <Icon className="w-5 h-5 text-[#F0B323]" />
      </div>
      <div>
        <div className="font-mono font-bold text-sm uppercase tracking-wide mb-1">{title}</div>
        <p className="text-sm opacity-80 leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

function App() {
  const formattedLoopExample = useMemo(() => {
    const model = models[Math.floor(Math.random() * models.length)];
    return highlightCode(buildLoopExample(model));
  }, []);

  return (
    <div className="min-h-screen border-x-4 md:border-x-8 border-foreground mx-auto max-w-[1600px] relative">
      <div className="fixed inset-0 scanline z-50 pointer-events-none mix-blend-overlay opacity-30"></div>
      
      {/* Nav/Header */}
      <header className="border-b-4 border-foreground p-6 flex justify-between items-center tech-grid">
        <div className="font-mono font-bold text-2xl tracking-tighter mix-blend-difference bg-foreground text-background px-2">
          GLOOP
        </div>
        <div className="hidden md:flex gap-6 font-mono text-xs uppercase font-bold">
          <a href="#what" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">What</a>
          <a href="#why" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Why</a>
          <a href="#features" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Features</a>
          <a href="#library" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Library</a>
          <a href="#install" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Install</a>
        </div>
        <Button variant="outline" size="sm" onClick={() => window.open('https://github.com/ianrumac/gloop', '_blank')}>
          GITHUB
        </Button>
      </header>

      {/* Hero */}
      <main>
        <section className="border-b-4 border-foreground">
          <div className="p-8 md:p-16 lg:p-24 tech-grid relative">
            <div className="absolute top-0 right-0 w-16 h-16 border-b-4 border-l-4 border-foreground bg-accent"></div>

            <div className="max-w-4xl space-y-8 animate-fade-up">
              <div className="inline-flex items-center gap-2 border-2 border-foreground bg-background px-3 py-1 font-mono text-xs font-bold uppercase w-fit">
                <div className="w-2 h-2 bg-accent animate-pulse"></div>
                OPEN-SOURCE AGENT HARNESS
              </div>

              <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tighter leading-[0.85] uppercase">
                The AI agent<br/>you can <span className="text-accent">take apart.</span>
              </h1>

              <p className="text-xl md:text-2xl font-medium max-w-2xl leading-relaxed">
                Gloop is an <strong>open agent harness</strong> — a hackable framework for running AI agents in your terminal. 
                Use any model. Swap any part. Build tools on the fly. 
                Let it modify its own code. Or just use it as-is.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 pt-4">
                <Button size="lg" variant="accent" className="gap-2" onClick={() => document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' })}>
                  <Terminal className="w-5 h-5" />
                  GET STARTED
                </Button>
                <Button variant="outline" size="lg" className="gap-2" onClick={() => document.getElementById('what')?.scrollIntoView({ behavior: 'smooth' })}>
                  <ArrowRight className="w-5 h-5" />
                  LEARN MORE
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* What is Gloop — plain English */}
        <section id="what" className="grid md:grid-cols-2 border-b-4 border-foreground">
          <div className="p-8 md:p-16 border-b-4 md:border-b-0 md:border-r-4 border-foreground">
            <div className="space-y-8">
              <div className="font-mono text-sm tracking-widest text-accent border-b-2 border-foreground/20 pb-4">
                WHAT IS A HARNESS?
              </div>

              <h2 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
                Think of it like a <span className="text-accent">shell for AI agents.</span>
              </h2>

              <div className="space-y-4 text-lg leading-relaxed opacity-90">
                <p>
                  A harness is the runtime that wraps an LLM and gives it the ability to <em>do things</em> — 
                  read files, run commands, call APIs, remember context.
                </p>
                <p>
                  Most harnesses (Claude Code, Codex, Cursor) are closed. You can't change how they work, 
                  what tools they have, or how they think.
                </p>
                <p>
                  <strong>Gloop is different.</strong> It's designed to be taken apart, modified, and extended. 
                  The agent itself can edit the harness it's running in.
                </p>
              </div>
            </div>
          </div>

          <div className="p-8 md:p-16 flex flex-col justify-center">
            <div className="space-y-6">
              <div className="font-mono text-sm tracking-widest text-muted-foreground border-b-2 border-foreground/20 pb-4">
                HOW IT WORKS
              </div>

              <div className="space-y-5">
                <div className="flex gap-4 items-start">
                  <span className="font-mono text-accent font-bold text-lg shrink-0 w-8">01</span>
                  <div>
                    <div className="font-bold mb-1">You talk to it</div>
                    <p className="text-sm opacity-70">Type a message in your terminal. Ask it to do anything — code, deploy, refactor, explore.</p>
                  </div>
                </div>
                <div className="flex gap-4 items-start">
                  <span className="font-mono text-accent font-bold text-lg shrink-0 w-8">02</span>
                  <div>
                    <div className="font-bold mb-1">It thinks & acts</div>
                    <p className="text-sm opacity-70">The LLM reasons, then calls tools — reads files, runs shell commands, writes code, asks you questions.</p>
                  </div>
                </div>
                <div className="flex gap-4 items-start">
                  <span className="font-mono text-accent font-bold text-lg shrink-0 w-8">03</span>
                  <div>
                    <div className="font-bold mb-1">You extend it</div>
                    <p className="text-sm opacity-70">Add custom tools, change the model, write skills, or let gloop modify itself. It's your agent.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Why Gloop Exists */}
        <section id="why" className="border-b-4 border-foreground bg-foreground text-background">
          <div className="p-8 md:p-16">
            <div className="max-w-4xl mx-auto space-y-10">
              <div className="space-y-4">
                <div className="font-mono text-sm tracking-widest text-[#F0B323] border-b-2 border-background/20 pb-4">
                  WHY GLOOP EXISTS
                </div>
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
                  A foundation for <span className="text-[#F0B323]">experimenting</span> with agents.
                </h2>
                <p className="text-lg opacity-80 max-w-2xl leading-relaxed">
                  Popular agent tools are black boxes. You can't test ideas about how agents should work — 
                  different tool formats, memory strategies, or self-modification patterns. 
                  Gloop is an open harness built for exactly that.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                {whyGloop.map((item, i) => (
                  <div key={i} className="border-2 border-background/20 p-5 hover:border-[#F0B323]/60 transition-colors">
                    <div className="font-mono text-sm font-bold text-[#F0B323] mb-2">{item.q}</div>
                    <p className="text-sm opacity-70 leading-relaxed">{item.a}</p>
                  </div>
                ))}
              </div>

              <div className="border-t-2 border-background/20 pt-6 font-mono text-sm opacity-60 max-w-xl">
                // Gloop started as a fun experiment to see how far agent harnesses can go. 
                It's made for entertainment as much as serious research.
                If you find a bug, just tell it to fix itself.
              </div>
            </div>
          </div>
        </section>

        {/* Marquee Banner */}
        <div className="border-b-4 border-foreground bg-accent text-accent-foreground py-3 overflow-hidden whitespace-nowrap flex font-mono text-sm font-bold">
          <div className="marquee-content gap-8">
            {[...marqueeItems, ...marqueeItems, ...marqueeItems].map((phrase, i) => (
              <span key={i} className="flex items-center gap-4">
                {phrase} <div className="w-2 h-2 rounded-full bg-foreground"></div>
              </span>
            ))}
          </div>
        </div>

        {/* Features Grid */}
        <section id="features" className="border-b-4 border-foreground">
          <div className="p-8 md:p-12 border-b-4 border-foreground">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight uppercase">What you get</h2>
            <p className="font-mono text-sm opacity-60 mt-2">Everything you need. Nothing you don't.</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => (
              <div 
                key={i} 
                className={`
                  p-8 md:p-12 hover:bg-foreground hover:text-background transition-colors duration-300 group cursor-crosshair
                  border-b-4 md:border-b-0 border-foreground
                  ${(i % 3 !== 2) ? 'lg:border-r-4' : ''} 
                  ${(i % 2 !== 1) ? 'md:border-r-4 lg:border-r-4' : 'md:border-r-0 lg:border-r-4'}
                  ${i < 3 ? 'md:border-b-4 lg:border-b-4' : ''}
                  ${i === 3 ? 'md:border-r-4 lg:border-r-0 lg:border-b-0' : ''}
                  ${i === 4 ? 'lg:border-r-4' : ''}
                `}
                style={{ borderRightWidth: '4px', borderBottomWidth: '4px' }}
              >
                <div className="mb-12 flex justify-between items-start">
                  <div className="p-3 border-2 border-current rounded-none bg-background group-hover:bg-foreground transition-colors">
                    <f.icon className="w-8 h-8 group-hover:text-[#F0B323] transition-colors" />
                  </div>
                  <span className="font-mono text-4xl font-black opacity-20 group-hover:opacity-40 transition-opacity">
                    0{i + 1}
                  </span>
                </div>
                <h3 className="text-2xl font-bold font-mono tracking-tight mb-4 uppercase group-hover:text-accent transition-colors">
                  {f.title}
                </h3>
                <p className="font-medium opacity-80 leading-relaxed">
                  {f.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Core Architecture — Code Display */}
        <section id="core" className="grid md:grid-cols-2 border-b-4 border-foreground">
          <div className="p-8 md:p-16 flex flex-col justify-center border-b-4 md:border-b-0 md:border-r-4 border-foreground">
            <div className="space-y-6">
              <div className="font-mono text-sm tracking-widest text-accent border-b-2 border-foreground/20 pb-4">
                UNDER THE HOOD
              </div>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
                Pure data,<br/>all the way down.
              </h2>
              <p className="text-lg opacity-80 leading-relaxed max-w-md">
                Agent execution is modeled as recursive evaluation of <strong>Forms</strong> — 
                simple data structures that describe what to do next. No hidden state. 
                No magic. Just a loop that evaluates until done.
              </p>
              <div className="space-y-3 font-mono text-sm opacity-70">
                <div className="flex gap-3"><span className="text-accent">→</span> Serializable — pause, resume, inspect any step</div>
                <div className="flex gap-3"><span className="text-accent">→</span> Testable — pure functions with injected effects</div>
                <div className="flex gap-3"><span className="text-accent">→</span> Composable — Forms nest, sequence, and branch</div>
              </div>
            </div>
          </div>

          <div className="bg-foreground text-background p-8 md:p-16 flex flex-col relative overflow-hidden">
            <div className="absolute top-4 right-4 text-muted/20">
               <CornerRightDown className="w-32 h-32" />
            </div>
            <div className="flex justify-between items-center mb-8 border-b-2 border-background/20 pb-4">
              <span className="font-mono text-sm tracking-widest text-[#F0B323]">SRC/CORE.TS</span>
            </div>
            <pre className="font-mono text-sm md:text-base leading-relaxed overflow-x-auto text-[#666666]">
              <code className="font-mono whitespace-pre" dangerouslySetInnerHTML={{ __html: formattedCode }} />
            </pre>
            <div className="mt-auto pt-8 flex items-center gap-4">
              <div className="h-[2px] w-full bg-background/20"></div>
              <span className="font-mono text-xs whitespace-nowrap text-[#FF5900]">EVALUATION COMPLETE</span>
            </div>
          </div>
        </section>

        {/* GLOOP-LOOP Library Section */}
        <section id="library" className="grid md:grid-cols-2 border-b-4 border-foreground">
          <div className="p-8 md:p-16 flex flex-col justify-center border-b-4 md:border-b-0 md:border-r-4 border-foreground relative">
            <div className="absolute bottom-0 left-0 w-12 h-12 border-t-4 border-r-4 border-foreground bg-[#F0B323]"></div>

            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 border-2 border-foreground bg-background px-3 py-1 font-mono text-xs font-bold uppercase w-fit">
                <div className="w-2 h-2 bg-[#F0B323] animate-pulse"></div>
                NPM PACKAGE
              </div>

              <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter leading-[0.85] uppercase">
                Gloop<br/><span className="text-[#F0B323]">Loop</span>
              </h2>

              <p className="text-xl md:text-2xl font-medium max-w-md leading-relaxed">
                The agent loop as a library. Drop it into your backend, your CLI tool, or your website. 
                3 lines to a working AI agent.
              </p>

              <div className="space-y-3 pt-4 border-t-4 border-foreground max-w-md">
                <div className="font-mono text-sm flex items-start gap-3">
                  <span className="text-accent font-bold shrink-0">01</span>
                  <span>Built-in tools: file I/O, shell, memory, context management</span>
                </div>
                <div className="font-mono text-sm flex items-start gap-3">
                  <span className="text-accent font-bold shrink-0">02</span>
                  <span>Works with any OpenAI-compatible provider via OpenRouter</span>
                </div>
                <div className="font-mono text-sm flex items-start gap-3">
                  <span className="text-accent font-bold shrink-0">03</span>
                  <span>Add custom tools, plug in your own memory, override anything</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 pt-4">
                <CopyBlock text="npm install @hypen-space/gloop-loop" />
              </div>
            </div>
          </div>

          <div className="bg-foreground text-background p-8 md:p-16 flex flex-col relative overflow-hidden">
            <div className="absolute top-4 right-4 text-muted/20">
              <Code2 className="w-24 h-24" />
            </div>
            <div className="flex justify-between items-center mb-8 border-b-2 border-background/20 pb-4">
              <span className="font-mono text-sm tracking-widest text-[#F0B323]">YOUR-APP.TS</span>
            </div>
            <pre className="font-mono text-sm md:text-base leading-relaxed overflow-x-auto text-[#666666]">
              <code className="font-mono whitespace-pre" dangerouslySetInnerHTML={{ __html: formattedLoopExample }} />
            </pre>
            <div className="mt-auto pt-8 flex items-center gap-4">
              <div className="h-[2px] w-full bg-background/20"></div>
              <span className="font-mono text-xs whitespace-nowrap text-[#F0B323]">READY TO LOOP</span>
            </div>
          </div>
        </section>

        {/* Install Section */}
        <section id="install" className="border-b-4 border-foreground">
          <div className="grid md:grid-cols-2">
            {/* Left: Install command */}
            <div className="p-8 md:p-16 border-b-4 md:border-b-0 md:border-r-4 border-foreground tech-grid relative">
              <div className="absolute bottom-0 left-0 w-12 h-12 border-t-4 border-r-4 border-foreground bg-accent"></div>
              
              <div className="space-y-8">
                <div className="inline-flex items-center gap-2 border-2 border-foreground bg-background px-3 py-1 font-mono text-xs font-bold uppercase w-fit">
                  <div className="w-2 h-2 bg-accent animate-pulse"></div>
                  GET STARTED
                </div>

                <h2 className="text-4xl md:text-5xl font-bold tracking-tighter leading-[0.9] uppercase">
                  Install<br/>Gloop.
                </h2>

                <p className="font-medium opacity-80 leading-relaxed max-w-sm">
                  Clone the repo, run setup, start talking to your agent. One script handles everything.
                </p>

                <CopyBlock text="git clone https://github.com/ianrumac/gloop && cd gloop && ./setup.sh" />

                <div className="space-y-2 font-mono text-xs opacity-60 pt-4 border-t-2 border-foreground/20">
                  <div><span className="text-accent">{'>'}</span> requires bun or node.js</div>
                  <div><span className="text-accent">{'>'}</span> setup.sh installs deps and links the `gloop` command globally</div>
                </div>
              </div>
            </div>

            {/* Right: Quick reference */}
            <div className="p-8 md:p-16 bg-foreground text-background relative">
              <div className="absolute top-4 right-4 text-muted/10">
                <Cpu className="w-24 h-24" />
              </div>

              <div className="space-y-8">
                <div className="font-mono text-sm tracking-widest text-[#F0B323] border-b-2 border-background/20 pb-4">
                  QUICK REFERENCE
                </div>

                <div className="space-y-6">
                  <InfoRow
                    icon={Terminal}
                    title="Run it"
                    text={<>Type <code className="text-[#F0B323] font-mono">gloop</code> in any directory. It starts with Grok by default, or pass a model name.</>}
                  />
                  <InfoRow
                    icon={Wrench}
                    title="Add tools"
                    text={<>Drop a <code className="text-[#F0B323] font-mono">.ts</code> file in <code className="text-[#F0B323] font-mono">.gloop/tools/</code> and call <code className="text-[#F0B323] font-mono">Reload</code>. Done.</>}
                  />
                  <InfoRow
                    icon={GitFork}
                    title="Clone per project"
                    text={<>Run <code className="text-[#F0B323] font-mono">gloop --clone</code> to get a local gloop with its own config, tools, and memory.</>}
                  />
                  <InfoRow
                    icon={Brain}
                    title="Let it fix itself"
                    text="Found a bug? Tell gloop about it. It can read its own source, patch, and restart."
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer id="system" className="bg-foreground text-background grid md:grid-cols-2 p-8 md:p-16 gap-16">
        <div>
           <h2 className="text-5xl md:text-6xl font-bold uppercase mb-8 leading-none">
             <span className="text-accent">Gloop</span><br/>
             Open Agent<br/>
             Harness.
           </h2>
           <div className="w-16 h-4 bg-accent mb-8"></div>
           <p className="font-mono max-w-sm opacity-80 mb-8">
             An open, hackable agent harness. Use any model. Modify anything. 
             Built for people who want to understand and control their AI tools.
           </p>
           <div className="font-mono text-xs opacity-50 flex items-start gap-2 max-w-sm uppercase">
             <span className="text-accent mt-0.5">{'>'}</span>
             <span>(this website was made by gloop, about gloop, for gloop)</span>
           </div>
        </div>
        <div className="flex flex-col justify-end items-start md:items-end font-mono text-sm gap-4">
          <div className="grid grid-cols-2 gap-x-12 gap-y-4 mb-8">
            <div>
              <div className="opacity-50 mb-1">LICENSE</div>
              <div className="font-bold">MIT</div>
            </div>
            <div>
              <div className="opacity-50 mb-1">VERSION</div>
              <div className="font-bold">1.0.0</div>
            </div>
            <div>
              <div className="opacity-50 mb-1">STATUS</div>
              <div className="font-bold text-[#F0B323]">ONLINE</div>
            </div>
            <div>
              <div className="opacity-50 mb-1">YEAR</div>
              <div className="font-bold">2026</div>
            </div>
          </div>
          <Button variant="outline" className="border-background text-background hover:bg-background hover:text-foreground"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            RETURN TO TOP <ArrowRight className="ml-2 w-4 h-4 -rotate-90" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

export default App;
