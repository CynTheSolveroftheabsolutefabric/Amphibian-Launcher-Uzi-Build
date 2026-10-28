using System;
using System.Linq;
using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Collections.Generic;
using Mono.Cecil;

string profileOut = args[0];
string profileAsm = args[1];

// Filters come in two flavors:
//   "<prefix>"  -> StartsWith match. Legacy behavior: matches the type plus any
//                  sibling/nested type sharing the prefix (e.g. "...Int2ObjectMap"
//                  also catches "...Int2ObjectMaps").
//   "@<path>"   -> read the file; each non-empty, non-'#' line is an EXACT type
//                  name. Matches that type and its nested types ("<name>/..."),
//                  but NOT sibling classes. Use for a precise, hand-curated list.
// An "@<path>" list may also hold METHOD lines, "<type>::<name>(<parameter types>)" in mono's type names
// ("java.util.zip.Deflater::deflateBytesBytes(long,byte[],int,int,byte[],int,int,int,int)"): a type named only by
// method lines contributes exactly those methods. That is the form `--list-out` writes (R498).
// and EXCLUSIONS, applied after them (plan A1, R419):
//   "!<type>"         -> drop that exact type and its nested types from the profile.
//   "!<type>::<name>" -> drop every method of that exact type with that name (all overloads).
//   "!<prefix>*"      -> drop every type whose full name starts with <prefix> (a package: "!java.util.stream.*").
// An excluded method gets no AOT body, so the runtime's JIT tier may compile it (an AOT body makes a method
// permanently JIT-ineligible: interp.c's AOT check). Its AOT callers then pay an AOT->JIT transition per call --
// census them first.
List<string> prefixFilters = new();
HashSet<string> exactFilters = new();
HashSet<string> excludedTypes = new();
HashSet<(string, string)> excludedMethods = new();
List<string> excludedPrefixes = new();
HashSet<string> exactMethods = new();
HashSet<string> exactMethodTypes = new();
// Regeneration (R498): --keep-symbols <file> keeps only the methods whose AOT symbol is listed (one per line, as V8's
// perf map and the wasm name section spell them); --close adds, to a fixpoint, every method they reach by a direct call
// that the filters admit; --list-out <file> writes the result as method lines.
string? keepSymbolsPath = null, listOutPath = null;
bool closeOverCalls = false;
var filterArgs = args.Skip(2).ToList();
for (int ai = 0; ai < filterArgs.Count; ai++) {
	var arg = filterArgs[ai];
	if (arg == "--keep-symbols") { keepSymbolsPath = filterArgs[++ai]; continue; }
	if (arg == "--list-out") { listOutPath = filterArgs[++ai]; continue; }
	if (arg == "--close") { closeOverCalls = true; continue; }
	if (arg.StartsWith("!")) {
		var x = arg.Substring(1);
		int sep = x.IndexOf("::");
		if (sep >= 0)
			excludedMethods.Add((x.Substring(0, sep), x.Substring(sep + 2)));
		else if (x.Length > 1 && x.EndsWith("*"))
			excludedPrefixes.Add(x.Substring(0, x.Length - 1));
		else
			excludedTypes.Add(x);
	} else if (arg.StartsWith("@")) {
		var path = arg.Substring(1);
		foreach (var raw in File.ReadAllLines(path)) {
			var line = raw.Trim();
			if (line.Length == 0 || line.StartsWith("#"))
				continue;
			int sep = line.IndexOf("::");
			if (sep > 0) {
				exactMethods.Add(line);
				exactMethodTypes.Add(line.Substring(0, sep));
			} else {
				exactFilters.Add(line);
			}
		}
	} else {
		prefixFilters.Add(arg);
	}
}

bool CheckFilters(string name)
{
	foreach (var filter in prefixFilters) {
		if (name.StartsWith(filter))
			return true;
	}

	if (exactFilters.Count > 0) {
		// Exact match against the listed type itself...
		if (exactFilters.Contains(name))
			return true;
		// ...and against nested types, whose Cecil FullName is "<declaring>/<nested>".
		int slash = name.IndexOf('/');
		if (slash >= 0 && exactFilters.Contains(name.Substring(0, slash)))
			return true;
	}

	return false;
}

// Mirrors mono_type_get_desc / mono_signature_full_name so that signatures
// produced here match what the AOT compiler computes for loaded methods.
string MonoTypeName(TypeReference tref)
{
	if (tref is ByReferenceType brt)
		return MonoTypeName(brt.ElementType) + "&";
	if (tref is PointerType pt)
		return MonoTypeName(pt.ElementType) + "*";
	if (tref is OptionalModifierType omt)
		return MonoTypeName(omt.ElementType) + " modopt(" + MonoTypeName(omt.ModifierType) + ")";
	if (tref is RequiredModifierType rmt)
		return MonoTypeName(rmt.ElementType) + " modreq(" + MonoTypeName(rmt.ModifierType) + ")";
	if (tref is ArrayType at) {
		if (at.IsVector)
			return MonoTypeName(at.ElementType) + "[]";
		var sb = new StringBuilder();
		sb.Append(MonoTypeName(at.ElementType));
		sb.Append('[');
		for (int i = 1; i < at.Rank; i++) sb.Append(',');
		sb.Append(']');
		return sb.ToString();
	}
	if (tref is GenericInstanceType git) {
		var sb = new StringBuilder();
		sb.Append(MonoTypeName(git.ElementType));
		sb.Append('<');
		for (int i = 0; i < git.GenericArguments.Count; i++) {
			if (i > 0) sb.Append(", ");
			sb.Append(MonoTypeName(git.GenericArguments[i]));
		}
		sb.Append('>');
		return sb.ToString();
	}
	if (tref is GenericParameter gp) {
		if (!string.IsNullOrEmpty(gp.Name))
			return gp.Name;
		return (gp.Type == GenericParameterType.Type ? "!" : "!!") + gp.Position;
	}

	switch (tref.FullName) {
		case "System.Void": return "void";
		case "System.Boolean": return "bool";
		case "System.Char": return "char";
		case "System.SByte": return "sbyte";
		case "System.Byte": return "byte";
		case "System.Int16": return "int16";
		case "System.UInt16": return "uint16";
		case "System.Int32": return "int";
		case "System.UInt32": return "uint";
		case "System.Int64": return "long";
		case "System.UInt64": return "ulong";
		case "System.IntPtr": return "intptr";
		case "System.UIntPtr": return "uintptr";
		case "System.Single": return "single";
		case "System.Double": return "double";
		case "System.String": return "string";
		case "System.Object": return "object";
	}

	if (tref.IsNested)
		return MonoTypeName(tref.DeclaringType) + "/" + tref.Name;

	if (string.IsNullOrEmpty(tref.Namespace))
		return tref.Name;
	return tref.Namespace + "." + tref.Name;
}

string MonoSignature(MethodDefinition m)
{
	var sb = new StringBuilder();
	sb.Append(MonoTypeName(m.ReturnType));
	sb.Append('(');
	for (int i = 0; i < m.Parameters.Count; i++) {
		if (i > 0) sb.Append(',');
		sb.Append(MonoTypeName(m.Parameters[i].ParameterType));
	}
	sb.Append(')');
	return sb.ToString();
}

// The readable key of a method list line.
string MethodKey(TypeDefinition td, MethodDefinition m) =>
	MonoTypeFullName(td) + "::" + m.Name + "(" + string.Join(",", m.Parameters.Select(p => MonoTypeName(p.ParameterType))) + ")";

// mono's get_debug_sym (aot-compiler.c): alphanumerics kept, " ()" dropped, ", " -> "_", '(' ')' '>' dropped, else '_'.
string DebugSym(string name1)
{
	var sb = new StringBuilder();
	for (int i = 0; i < name1.Length; ++i) {
		char c = name1[i];
		if (i == 0 && c >= '0' && c <= '9') sb.Append('_');
		else if (c < 0x80 && char.IsLetterOrDigit(c)) sb.Append(c);
		else if (c == ' ' && i + 2 < name1.Length && name1[i + 1] == '(' && name1[i + 2] == ')') i += 2;
		else if (c == ',' && i + 1 < name1.Length && name1[i + 1] == ' ') { sb.Append('_'); i++; }
		else if (c == '(' || c == ')' || c == '>') { }
		else sb.Append('_');
	}
	return sb.ToString();
}

string MonoTypeFullName(TypeDefinition td)
{
	if (td.IsNested)
		return MonoTypeName(td.DeclaringType) + "/" + td.Name;
	return td.Namespace + "." + td.Name;
}

IEnumerable<TypeDefinition> WalkTypes(TypeDefinition td)
{
	yield return td;
	foreach (var n in td.NestedTypes)
		foreach (var x in WalkTypes(n))
			yield return x;
}

Console.Error.WriteLine($"Writing aot profile '{profileOut}' for asm '{profileAsm}' with {prefixFilters.Count} prefix filter(s), {exactFilters.Count} exact filter(s), {excludedTypes.Count} excluded type(s), {excludedPrefixes.Count} excluded prefix(es) and {excludedMethods.Count} excluded method name(s)");

var asm = AssemblyDefinition.ReadAssembly(profileAsm);
var mod = asm.MainModule;

var profileMvid = mod.Mvid.ToString();
var profileName = asm.Name.Name;
List<(TypeDefinition td, List<MethodDefinition> methods)> profileTypes = new();
HashSet<string> foundMethods = new();

foreach (var top in mod.Types) {
	foreach (var ty in WalkTypes(top)) {
		if (ty.Name.StartsWith("<"))
			continue;

		bool wholeType = CheckFilters(ty.FullName);
		bool listedType = exactMethodTypes.Contains(MonoTypeFullName(ty));
		if (!wholeType && !listedType)
			continue;
		if (excludedTypes.Contains(ty.FullName)) {
			Console.Error.WriteLine($"Excluded type '{ty.FullName}'");
			continue;
		}
		if (excludedPrefixes.Any(p => ty.FullName.StartsWith(p))) {
			Console.Error.WriteLine($"Excluded type '{ty.FullName}' (prefix)");
			continue;
		}
		{
			int slash = ty.FullName.IndexOf('/');
			if (slash >= 0 && excludedTypes.Contains(ty.FullName.Substring(0, slash))) {
				Console.Error.WriteLine($"Excluded nested type '{ty.FullName}'");
				continue;
			}
		}

		var methods = new List<MethodDefinition>();
		foreach (var m in ty.Methods) {
			if (excludedMethods.Contains((ty.FullName, m.Name))) {
				Console.Error.WriteLine($"Excluded method '{ty.FullName}::{m.Name}'");
				continue;
			}
			if (!wholeType) {
				var key = MethodKey(ty, m);
				if (!exactMethods.Contains(key))
					continue;
				foundMethods.Add(key);
			}
			methods.Add(m);
		}

		if (methods.Count > 0) {
			Console.WriteLine($"Got {methods.Count} methods for type '{ty.FullName}'");
			profileTypes.Add((ty, methods));
		}
	}
}

if (exactMethods.Count > 0) {
	var stale = exactMethods.Where(x => !foundMethods.Contains(x)).ToList();
	Console.Error.WriteLine($"{exactMethods.Count - stale.Count} of {exactMethods.Count} listed methods found");
	foreach (var x in stale.Take(20))
		Console.Error.WriteLine($"  listed method not in '{profileAsm}' (or filtered out): {x}");
}

if (keepSymbolsPath != null) {
	// An AOT method's symbol is the assembly name + "_" + mono's get_debug_sym of "<type>:<name> (<params>)"
	// (aot-compiler.c, sanitized); a name that collides gets "_<n>", so a collided name keeps every method sharing it.
	string symPrefix = System.Text.RegularExpressions.Regex.Replace(profileName, "[^A-Za-z0-9_]", "_") + "_";
	var bySym = new Dictionary<string, List<MethodDefinition>>();
	foreach (var (td, ms) in profileTypes)
		foreach (var m in ms) {
			var k = symPrefix + DebugSym(MonoTypeFullName(td) + ":" + m.Name + " (" + string.Join(",", m.Parameters.Select(x => MonoTypeName(x.ParameterType))) + ")");
			if (!bySym.TryGetValue(k, out var l)) bySym[k] = l = new();
			l.Add(m);
		}
	var keep = new HashSet<MethodDefinition>();
	int seeds = 0, unmapped = 0;
	foreach (var raw in File.ReadAllLines(keepSymbolsPath)) {
		var w = raw.Trim();
		if (w.Length == 0 || w.StartsWith("#")) continue;
		seeds++;
		if (!bySym.TryGetValue(w, out var hit)) {
			var mm = System.Text.RegularExpressions.Regex.Match(w, @"^(.*)_\d+$");
			if (!(mm.Success && bySym.TryGetValue(mm.Groups[1].Value, out hit) && hit.Count > 1)) { unmapped++; continue; }
		}
		foreach (var m in hit) keep.Add(m);
	}
	Console.Error.WriteLine($"--keep-symbols: {seeds} symbols -> {keep.Count} methods ({unmapped} name no method in the filtered set: wrappers, or filtered out)");
	if (closeOverCalls) {
		// A call from an AOT'd method to a same-image method outside the profile compiles to an indirect call that may
		// enter the interpreter (mono calls.c can_enter_interp), and a callee LLVM inlined into its AOT callers never
		// shows in a perf map -- so a profile cut to what ran pays a boundary crossing at every such site (R498).
		var eligible = new HashSet<MethodDefinition>(profileTypes.SelectMany(x => x.methods));
		var work = new Stack<MethodDefinition>(keep);
		int before = keep.Count;
		while (work.Count > 0) {
			var m = work.Pop();
			if (!m.HasBody) continue;
			foreach (var ins in m.Body.Instructions) {
				var c = ins.OpCode.Code;
				if (c != Mono.Cecil.Cil.Code.Call && c != Mono.Cecil.Cil.Code.Newobj && c != Mono.Cecil.Cil.Code.Callvirt && c != Mono.Cecil.Cil.Code.Ldftn) continue;
				if (ins.Operand is not MethodReference mr) continue;
				MethodDefinition? md = null;
				try { md = mr.Resolve(); } catch { }
				if (md == null || !eligible.Contains(md) || keep.Contains(md)) continue;
				// a virtual call stays indirect whatever the profile; mono devirtualizes non-virtual, final and sealed targets
				if (c == Mono.Cecil.Cil.Code.Callvirt && md.IsVirtual && !md.IsFinal && !md.DeclaringType.IsSealed) continue;
				keep.Add(md);
				work.Push(md);
			}
		}
		Console.Error.WriteLine($"--close: {before} -> {keep.Count} methods");
	}
	profileTypes = profileTypes.Select(x => (x.td, x.methods.Where(keep.Contains).ToList())).Where(x => x.Item2.Count > 0).ToList();
} else if (closeOverCalls) {
	Console.Error.WriteLine("--close needs --keep-symbols: the filter arguments bound what the closure may add");
	return 1;
}

if (listOutPath != null) {
	var lines = new List<string> {
		"# IKVM.Java methods to AOT-compile, one per line: <type>::<name>(<parameter types>), in mono's type names; a line",
		"# covers every method with that name and parameter list (IKVM's covariant bridges differ only in return type).",
		$"# Generated by aotprofile/Program.cs --list-out ({profileTypes.Sum(x => x.methods.Count)} methods" +
			(keepSymbolsPath != null ? $" from {Path.GetFileName(keepSymbolsPath)}{(closeOverCalls ? ", closed over direct calls" : "")}" : "") +
			"). Regenerate rather than hand-edit: see the Makefile's aot-java-methods target.",
	};
	// A line names every method with that name and parameter list: IKVM emits return-type overloads (covariant bridges).
	var seen = new HashSet<string>();
	foreach (var (td, ms) in profileTypes)
		foreach (var m in ms)
			if (seen.Add(MethodKey(td, m)))
				lines.Add(MethodKey(td, m));
	File.WriteAllLines(listOutPath, lines);
	Console.Error.WriteLine($"--list-out: wrote {lines.Count - 3} lines to '{listOutPath}'");
}

Console.Error.WriteLine($"Collected {profileTypes.Count} types ({profileTypes.Select(x => x.methods.Count).Sum()} methods)");

ArrayBufferWriter<byte> buf = new();
int nextID = 0;

void WriteSpan(int len, Func<Span<byte>, int> func)
{
	Span<byte> span = buf.GetSpan(len);
	buf.Advance(func(span));
}
void WriteByte(byte bite) => buf.Write(new byte[] { bite });
void WriteSInt(int num) => WriteSpan(4, span => { BinaryPrimitives.WriteInt32LittleEndian(span, num); return 4; });
void WriteUtf8(string str, bool length = true)
{
	var bytes = Encoding.UTF8.GetBytes(str);
	if (length)
		WriteSInt(bytes.Length);
	buf.Write(bytes);
}

WriteUtf8("AOTPROFILE", false);
WriteSInt((1 << 16) | 0); // (MAJOR << 16) | MINOR

var imageID = nextID++;
WriteByte(1); // AOTPROF_RECORD_IMAGE
WriteSInt(imageID);
WriteUtf8(profileName);
WriteUtf8(profileMvid);

const byte MONO_TYPE_CLASS = 0x12;

foreach (var (td, methods) in profileTypes)
{
	var typeID = nextID++;
	var typeName = MonoTypeFullName(td);

	WriteByte(2); // AOTPROF_RECORD_TYPE
	WriteSInt(typeID);
	WriteByte(MONO_TYPE_CLASS);
	WriteSInt(imageID);
	WriteSInt(-1); // ginst not supported
	WriteUtf8(typeName);

	foreach (var m in methods)
	{
		var methodID = nextID++;
		var sig = MonoSignature(m);
		WriteByte(4); // AOTPROF_RECORD_METHOD
		WriteSInt(methodID);
		WriteSInt(typeID);
		WriteSInt(-1); // no method ginst
		WriteSInt(m.Parameters.Count);
		WriteUtf8(m.Name);
		WriteUtf8(sig);
	}
}

WriteByte(0); // AOTPROF_RECORD_NONE
WriteSInt(0);

await using var file = File.Create(profileOut);
await file.WriteAsync(buf.WrittenMemory);
return 0;
