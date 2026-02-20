import { useEffect, useState, useRef } from 'react';
import { Terminal, Zap, Code2, Brain, GitBranch, Infinity, BookOpen, Type, ArrowRight, CornerRightDown, Copy, Check, Wrench, Globe, GitFork, Cpu } from 'lucide-react';
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
  // Tokenize the line character by character
  let result = '';
  let i = 0;
  
  while (i < line.length) {
    // Check for string literals
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== '"') end++;
      const str = line.slice(i, end + 1);
      result += `<span class="code-string">${escapeHtml(str)}</span>`;
      i = end + 1;
      continue;
    }
    
    // Check for words (identifiers/keywords)
    if (/[a-zA-Z_]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) end++;
      const word = line.slice(i, end);
      
      // Classify the word
      if (['type', 'function', 'switch', 'case', 'return'].includes(word)) {
        result += `<span class="code-keyword">${word}</span>`;
      } else if (['Form', 'World', 'Record', 'string', 'any'].includes(word)) {
        result += `<span class="code-type">${word}</span>`;
      } else {
        result += `<span class="code-ident">${word}</span>`;
      }
      i = end;
      continue;
    }
    
    // Everything else (punctuation, operators, whitespace)
    result += escapeHtml(line[i]);
    i++;
  }
  
  return result;
}

const formattedCode = highlightCode(coreCode);

const features = [
  {
    icon: Code2,
    title: 'Lisp Forms',
    description: 'Everything is data. S-expressions describe pure computation. No hidden state.',
  },
  {
    icon: Type,
    title: 'Type Safety',
    description: 'TypeScript end-to-end. Macros preserve hygiene. Static guarantees.',
  },
  {
    icon: Infinity,
    title: 'Recursion',
    description: 'eval(Form, World) → Form. Trampoline interpreter. Proper tail calls.',
  },
  {
    icon: Brain,
    title: 'Semantic Memory',
    description: 'Embeddings for recall. <remember> and <forget> tags. Long-term patterns.',
  },
  {
    icon: GitBranch,
    title: 'Self-Modifying',
    description: 'Edit code, reload tools, spawn subagents. Full introspection.',
  },
  {
    icon: BookOpen,
    title: 'SICP Principles',
    description: 'Metalinguistic abstraction. Elegance. Taste.',
  },
];

const philosophy = [
  'PURE COMPUTATION',
  'EVERYTHING IS DATA',
  'EVAL(FORM, WORLD) -> FORM',
  'STATIC GUARANTEES',
  'HYGIENIC MACROS',
  'PROPER TAIL CALLS'
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
  const [text, setText] = useState('');
  const fullText = 'function eval(form, world) { return eval(step(form, world), world); }';

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setText(fullText.slice(0, i));
      i++;
      if (i > fullText.length) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen border-x-4 md:border-x-8 border-foreground mx-auto max-w-[1600px] relative">
      <div className="fixed inset-0 scanline z-50 pointer-events-none mix-blend-overlay opacity-30"></div>
      
      {/* Nav/Header */}
      <header className="border-b-4 border-foreground p-6 flex justify-between items-center tech-grid">
        <div className="font-mono font-bold text-2xl tracking-tighter mix-blend-difference bg-foreground text-background px-2">
          GLOOP.SYS_01
        </div>
        <div className="hidden md:flex gap-6 font-mono text-xs uppercase font-bold">
          <a href="#core" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Core</a>
          <a href="#features" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Features</a>
          <a href="#install" className="hover:text-accent hover:underline decoration-2 underline-offset-4 transition-all">Install</a>
        </div>
        <Button variant="outline" size="sm">v1.0.0 (STABLE)</Button>
      </header>

      {/* Hero Content */}
      <main>
        <section className="grid md:grid-cols-2 border-b-4 border-foreground min-h-[80vh]">
          <div className="p-8 md:p-16 flex flex-col justify-center border-b-4 md:border-b-0 md:border-r-4 border-foreground tech-grid relative">
            <div className="absolute top-0 right-0 w-16 h-16 border-b-4 border-l-4 border-foreground bg-accent"></div>
            
            <div className="space-y-8 animate-fade-up">
              <div className="inline-flex items-center gap-2 border-2 border-foreground bg-background px-3 py-1 font-mono text-xs font-bold uppercase w-fit">
                <div className="w-2 h-2 bg-accent animate-pulse"></div>
                RECURSIVE AI AGENT
              </div>
              
              <h1 className="text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter leading-[0.85] uppercase">
                Gloop
              </h1>
              
              <p className="text-xl md:text-2xl font-medium max-w-md leading-relaxed">
                A self-modifying AI agent that thinks in pure functions. 
                Edits its own code. Manages its own memory. Runs in your terminal.
              </p>

              <div className="font-mono text-lg md:text-xl pt-6 border-t-4 border-foreground max-w-md">
                <span className="text-accent">//</span> Thinks in Forms.
                <br/>
                <span className="typing-cursor font-bold">{text}</span>
              </div>

              <div className="flex flex-wrap gap-4 pt-6">
                <Button size="lg" variant="accent" className="gap-2" onClick={() => document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' })}>
                  <Terminal className="w-5 h-5" />
                  INSTALL NOW
                </Button>
                <Button variant="outline" size="lg" className="gap-2" onClick={() => window.open('https://github.com/ianrumac/gloop', '_blank')}>
                  <Zap className="w-5 h-5" />
                  VIEW ON GITHUB
                </Button>
              </div>
            </div>
          </div>

          <div id="core" className="bg-foreground text-background p-8 md:p-16 flex flex-col relative overflow-hidden">
            <div className="absolute top-4 right-4 text-muted/20">
               <CornerRightDown className="w-32 h-32" />
            </div>
            <div className="flex justify-between items-center mb-8 border-b-2 border-background/20 pb-4">
              <span className="font-mono text-sm tracking-widest text-[#F0B323]">SRC/CORE.TS</span>
            </div>
            {/* Code block with syntax highlighting */}
            <pre className="font-mono text-sm md:text-base leading-relaxed overflow-x-auto text-[#666666]">
              <code className="font-mono whitespace-pre" dangerouslySetInnerHTML={{ __html: formattedCode }} />
            </pre>
            <div className="mt-auto pt-8 flex items-center gap-4">
              <div className="h-[2px] w-full bg-background/20"></div>
              <span className="font-mono text-xs whitespace-nowrap text-[#FF5900]">EVALUATION COMPLETE</span>
            </div>
          </div>
        </section>

        {/* Marquee Banner */}
        <div className="border-b-4 border-foreground bg-accent text-accent-foreground py-3 overflow-hidden whitespace-nowrap flex font-mono text-sm font-bold">
          <div className="marquee-content gap-8">
            {[...philosophy, ...philosophy, ...philosophy].map((phrase, i) => (
              <span key={i} className="flex items-center gap-4">
                {phrase} <div className="w-2 h-2 rounded-full bg-foreground"></div>
              </span>
            ))}
          </div>
        </div>

        {/* Features Grid */}
        <section id="features" className="border-b-4 border-foreground">
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
                style={{ borderRightWidth: '4px', borderBottomWidth: '4px' }} // Fallback forcing
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
        {/* Install Section */}
        <section id="install" className="border-b-4 border-foreground">
          <div className="grid md:grid-cols-2">
            {/* Left: Install command */}
            <div className="p-8 md:p-16 border-b-4 md:border-b-0 md:border-r-4 border-foreground tech-grid relative">
              <div className="absolute bottom-0 left-0 w-12 h-12 border-t-4 border-r-4 border-foreground bg-accent"></div>
              
              <div className="space-y-8">
                <div className="inline-flex items-center gap-2 border-2 border-foreground bg-background px-3 py-1 font-mono text-xs font-bold uppercase w-fit">
                  <div className="w-2 h-2 bg-accent animate-pulse"></div>
                  INSTALL
                </div>

                <h2 className="text-4xl md:text-5xl font-bold tracking-tighter leading-[0.9] uppercase">
                  Get<br/>Gloop.
                </h2>

                <p className="font-medium opacity-80 leading-relaxed max-w-sm">
                  Clone, run setup, start looping. One script handles everything.
                </p>

                <CopyBlock text="git clone https://github.com/ianrumac/gloop && cd gloop && ./setup.sh" />

                <div className="font-mono text-xs opacity-50 pt-4 border-t-2 border-foreground/20">
                  <span className="text-accent">{'>'}</span> requires bun or node.js
                </div>
              </div>
            </div>

            {/* Right: What you get */}
            <div className="p-8 md:p-16 bg-foreground text-background relative">
              <div className="absolute top-4 right-4 text-muted/10">
                <Cpu className="w-24 h-24" />
              </div>

              <div className="space-y-8">
                <div className="font-mono text-sm tracking-widest text-[#F0B323] border-b-2 border-background/20 pb-4">
                  WHAT YOU SHOULD KNOW
                </div>

                <div className="space-y-6">
                  <InfoRow
                    icon={Wrench}
                    title="Self-modifying"
                    text="Gloop can write its own features, fix its own bugs, and build its own tools."
                  />
                  <InfoRow
                    icon={Globe}
                    title="Global, yet local"
                    text="Gloop is global, but each directory can have its own gloop with local config and tools."
                  />
                  <InfoRow
                    icon={GitFork}
                    title="Clone per project"
                    text={<>To replicate gloop for the current directory, run <code className="text-[#F0B323] font-mono">gloop --clone</code></>}
                  />
                  <InfoRow
                    icon={Cpu}
                    title="Flexible modes"
                    text={<>Pass a model as argument, use <code className="text-[#F0B323] font-mono">task</code> for task mode, or <code className="text-[#F0B323] font-mono">--debug</code> to debug.</>}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer id="system" className="bg-foreground text-background grid md:grid-cols-2 p-8 md:p-16 gap-16">
        <div className="">
           <h2 className="text-5xl md:text-7xl font-bold uppercase mb-8 leading-none">
             <span className="text-accent">Gloop</span><br/>
             Core<br/>
             System.
           </h2>
           <div className="w-16 h-4 bg-accent mb-8"></div>
           <p className="font-mono max-w-sm opacity-80 mb-8">
             A self-modifying, recursive Lisp agent. Pure functional core. Thinks in Forms. Everything is data.
           </p>
           <div className="font-mono text-xs opacity-50 flex items-start gap-2 max-w-sm uppercase">
             <span className="text-accent mt-0.5">{'>'}</span>
             <span>(website made by gloop, based on gloop source code)</span>
           </div>
        </div>
        <div className="flex flex-col justify-end items-start md:items-end font-mono text-sm gap-4">
          <div className="grid grid-cols-2 gap-x-12 gap-y-4 mb-8">
            <div>
              <div className="opacity-50 mb-1">MODULE</div>
              <div className="font-bold">GLOOP CORE</div>
            </div>
            <div>
              <div className="opacity-50 mb-1">VERSION</div>
              <div className="font-bold">1.0.0-RC1</div>
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
