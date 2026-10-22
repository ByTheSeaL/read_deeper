import esbuild from "esbuild";

const production = process.argv[2] === "production";

/** The standard Obsidian sample-plugin bundle: one CommonJS main.js, obsidian left external. */
const context = await esbuild.context({
	bundle      : true,
	entryPoints : ["src/main.ts"],
	external    : ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	format      : "cjs",
	logLevel    : "info",
	minify      : production,
	outfile     : "main.js",
	sourcemap   : production ? false : "inline",
	target      : "es2020",
	treeShaking : true
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
