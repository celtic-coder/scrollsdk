const { exec, execSync } = require("child_process")
const recursiveReadSync = require("recursive-readdir-sync")
const jtree = require("../products/jtree.node.js")
const { TypeScriptRewriter } = require("../products/TypeScriptRewriter.js")
const { Disk } = require("../products/Disk.node.js")
class AbstractBuilder extends jtree.TreeNode {
  _getNodeTsConfig(outDir = "", inputFilePath = "") {
    return {
      compilerOptions: {
        types: ["node"],
        outDir: outDir,
        lib: ["es2017"],
        noImplicitAny: true,
        downlevelIteration: true,
        target: "es2017",
        module: "commonjs"
      },
      include: [inputFilePath]
    }
  }
  _getBrowserTsConfig(outDir = "", inputFilePath = "") {
    return {
      compilerOptions: {
        outDir: outDir,
        lib: ["es2017", "dom"],
        moduleResolution: "node",
        noImplicitAny: true,
        declaration: false,
        target: "es2017"
      },
      include: [inputFilePath]
    }
  }
  _combineTypeScriptFilesForNode(typeScriptScriptsInOrder) {
    // todo: prettify
    return typeScriptScriptsInOrder
      .map(src => this._read(src))
      .map(content =>
        new TypeScriptRewriter(content)
          //.removeRequires()
          .removeImports()
          .removeExports()
          .removeHashBang()
          .getString()
      )
      .join("\n")
  }
  _prettifyFile(path) {
    Disk.write(path, require("prettier").format(Disk.read(path), { semi: false, parser: "babel", printWidth: 160 }))
  }
  _combineTypeScriptFilesForBrowser(typeScriptScriptsInOrder) {
    const typeScriptScriptsInOrderBrowserOnly = typeScriptScriptsInOrder.filter(file => !file.includes(".node."))
    return typeScriptScriptsInOrderBrowserOnly
      .map(src => this._read(src))
      .map(content =>
        new TypeScriptRewriter(content)
          .removeRequires()
          .removeImports()
          .removeHashBang()
          .removeNodeJsOnlyLines()
          .changeDefaultExportsToWindowExports()
          .removeExports()
          .getString()
      )
      .join("\n")
  }
  async _buildBrowserTsc(inputFilePath) {
    return this._buildTsc(inputFilePath, true)
  }
  async _buildTsc(inputFilePath, forBrowser = false) {
    const outputFolder = this._getProductFolder()
    const configPath = outputFolder + "tsconfig.json"
    Disk.writeJson(configPath, forBrowser ? this._getBrowserTsConfig(outputFolder, inputFilePath) : this._getNodeTsConfig(outputFolder, inputFilePath))
    const prom = new Promise((resolve, reject) => {
      exec("tsc", (err, stdout, stderr) => {
        if (stderr || err) {
          console.error(err, stdout, stderr)
          return reject()
        }
        resolve(stdout)
      })
    })
    await prom
    Disk.rm(configPath)
    return prom
  }
  // todo: cleanup
  _getOutputFilePath(outputFileName) {
    return __dirname + "/../products/" + outputFileName
  }
  async _produceBrowserProductFromTypeScript(files = [], outputFileName) {
    const bundleFilePath = this._getBundleFilePath(outputFileName)
    this._write(bundleFilePath, this._combineTypeScriptFilesForBrowser(files))
    try {
      await this._buildBrowserTsc(bundleFilePath)
    } catch (err) {
      console.log(err)
    }
    this._prettifyFile(this._getOutputFilePath(productId))
  }
  _makeExecutable(file) {
    Disk.makeExecutable(file)
  }
  _getProductFolder() {
    return __dirname
  }
  _getBundleFilePath(outputFileName) {
    return this._getProductFolder() + `${outputFileName.replace(".js", ".ts")}`
  }
  async _produceNodeProductFromTypeScript(files, outputFileName, transformFn) {
    const bundleFilePath = this._getBundleFilePath(outputFileName)
    this._write(bundleFilePath, this._combineTypeScriptFilesForNode(files))
    const outputFilePath = this._getOutputFilePath(outputFileName)
    try {
      this._buildTsc(bundleFilePath, false)
    } catch (error) {
      console.log(error.status)
      console.log(error.message)
      console.log(error.stderr)
      console.log(error.stdout)
    }
    Disk.write(outputFilePath, transformFn(Disk.read(outputFilePath)))
    this._prettifyFile(outputFilePath)
    return outputFilePath
  }
  _readJson(path) {
    return JSON.parse(this._read(path))
  }
  _writeJson(path, obj) {
    this._write(path, JSON.stringify(obj, null, 2))
  }
  _updatePackageJson(packagePath, newVersion) {
    const packageJson = this._readJson(packagePath)
    packageJson.version = newVersion
    this._writeJson(packagePath, packageJson)
    console.log(`Updated ${packagePath} to ${newVersion}`)
  }
  _read(path) {
    const fs = this.require("fs")
    return fs.readFileSync(path, "utf8")
  }
  _mochaTest(filepath) {
    const reporter = require("tap-mocha-reporter")
    const proc = exec(`${filepath} _test`)
    proc.stdout.pipe(reporter("dot"))
    proc.stderr.on("data", data => console.error("stderr: " + data.toString()))
  }
  _write(path, str) {
    const fs = this.require("fs")
    return fs.writeFileSync(path, str, "utf8")
  }
  _checkGrammarFile(grammarPath) {
    // todo: test both with grammar.grammar and hard coded grammar program (eventually the latter should be generated from the former).
    const testTree = {}
    testTree[`hardCodedGrammarCheckOf${grammarPath}`] = equal => {
      // Arrange/Act
      const program = new jtree.GrammarProgram(this._read(grammarPath))
      const errs = program.getAllErrors()
      const exampleErrors = program.getErrorsInGrammarExamples()
      //Assert
      equal(errs.length, 0, "should be no errors")
      if (errs.length) console.log(errs.join("\n"))
      if (exampleErrors.length) console.log(exampleErrors)
      equal(exampleErrors.length, 0, exampleErrors.length ? "examples errs: " + exampleErrors : "no example errors")
    }
    testTree[`grammarGrammarCheckOf${grammarPath}`] = equal => {
      // Arrange/Act
      const program = jtree.makeProgram(grammarPath, __dirname + "/../langs/grammar/grammar.grammar")
      const errs = program.getAllErrors()
      //Assert
      equal(errs.length, 0, "should be no errors")
      if (errs.length) console.log(errs.join("\n"))
    }
    jtree.Utils.runTestTree(testTree)
  }
  _help(filePath = process.argv[1]) {
    const commands = this._getAllCommands()
    return `${commands.length} commands in ${filePath}:\n${commands.join("\n")}`
  }
  _getAllCommands() {
    return Object.getOwnPropertyNames(Object.getPrototypeOf(this))
      .filter(word => !word.startsWith("_") && word !== "constructor")
      .sort()
  }
  _getPartialMatches(commandName) {
    return this._getAllCommands().filter(item => item.startsWith(commandName))
  }
  _main() {
    const action = process.argv[2]
    const paramOne = process.argv[3]
    const paramTwo = process.argv[4]
    const print = console.log
    const builder = this
    const partialMatches = this._getPartialMatches(action)
    if (builder[action]) {
      builder[action](paramOne, paramTwo)
    } else if (!action) {
      print(this._help())
    } else if (partialMatches.length > 0) {
      if (partialMatches.length === 1) builder[partialMatches[0]](paramOne, paramTwo)
      else print(`Multiple matches for '${action}'. Options are:\n${partialMatches.join("\n")}`)
    } else print(`Unknown command '${action}'. Type 'jtree build' to see available commands.`)
  }
}
module.exports = { AbstractBuilder }
