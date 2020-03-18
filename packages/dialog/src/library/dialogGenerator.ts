#!/usr/bin/env node
/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
export * from './dialogGenerator'
import * as s from './schema'
import * as expressions from '@chrimc62/adaptive-expressions'
import * as fs from 'fs-extra'
import * as lg from '@chrimc62/botbuilder-lg'
import * as ppath from 'path'
import * as ph from './generatePhrases'
import { SubstitutionsEvaluator } from './substitutions'
import { processSchemas } from './processSchemas'

export enum FeedbackType {
    message,
    info,
    warning,
    error
}

export type Feedback = (type: FeedbackType, message: string) => void

function templatePath(name: string, dir: string): string {
    return ppath.join(dir, name)
}

export async function writeFile(path: string, val: any, force: boolean, feedback: Feedback) {
    try {
        if (force || !await fs.pathExists(path)) {
            feedback(FeedbackType.info, `Generating ${path}`)
            let dir = ppath.dirname(path)
            await fs.ensureDir(dir)
            await fs.writeFile(path, val)
        } else {
            feedback(FeedbackType.warning, `Skipping already existing ${path}`)
        }
    } catch (e) {
        feedback(FeedbackType.error, e.message)
    }
}

const expressionEngine = new expressions.ExpressionEngine((func: any) => {
    switch (func) {
        case 'phrase': return ph.PhraseEvaluator
        case 'phrases': return ph.PhrasesEvaluator
        case 'substitutions': return SubstitutionsEvaluator
        default: return expressions.ExpressionFunctions.lookup(func)
    }
})

type Template = lg.LGFile | string | undefined

async function findTemplate(name: string, templateDirs: string[]): Promise<Template> {
    let template: Template
    for (let dir of templateDirs) {
        let loc = templatePath(name, dir)
        if (await fs.pathExists(loc)) {
            // Direct file
            template = await fs.readFile(loc, 'utf8')
        } else {
            // LG file
            loc = templatePath(name + '.lg', dir)
            if (await fs.pathExists(loc)) {
                template = lg.LGParser.parseFile(loc, undefined, expressionEngine)
            }
        }
    }
    return template
}

function addPrefix(prefix: string, name: string): string {
    return `${prefix}-${name}`
}

// Add entry to the .lg generation context and return it.  
// This also ensures the file does not exist already.
type FileRef = { name: string, fallbackName: string, fullName: string, relative: string }
function addEntry(fullPath: string, outDir: string, tracker: any): FileRef | undefined {
    let ref: FileRef | undefined
    let basename = ppath.basename(fullPath, '.dialog')
    let ext = ppath.extname(fullPath).substring(1)
    let arr: FileRef[] = tracker[ext]
    if (!arr.find(ref => ref.name === basename)) {
        ref = {
            name: basename,
            fallbackName: basename.replace(/\.[^.]+\.lg/, '.lg'),
            fullName: ppath.basename(fullPath),
            relative: ppath.relative(outDir, fullPath)
        }
    }
    return ref
}

function existingRef(name: string, tracker: any): FileRef | undefined {
    let ext = ppath.extname(name).substring(1)
    let arr: FileRef[] = tracker[ext]
    if (!arr) {
        arr = []
        tracker[ext] = arr
    }
    return arr.find(ref => ref.fullName === name)
}

async function processTemplate(
    templateName: string,
    templateDirs: string[],
    outDir: string,
    scope: any,
    force: boolean,
    feedback: Feedback,
    ignorable: boolean): Promise<string> {
    let outPath = ''
    let oldDir = process.cwd()
    try {
        let ref = existingRef(templateName, scope.templates)
        if (ref) {
            // Simple file already existed
            outPath = ppath.join(outDir, ref.relative)
        } else {
            let template = await findTemplate(templateName, templateDirs)
            if (template !== undefined) {
                // Ignore templates that are defined, but are empty
                if (template) {
                    if (typeof template !== 'object' || template.templates.some(f => f.name === 'template')) {
                        // Constant file or .lg template so output
                        let filename = addPrefix(scope.prefix, templateName)
                        if (typeof template === 'object' && template.templates.some(f => f.name === 'filename')) {
                            filename = template.evaluateTemplate('filename', scope) as any as string
                        } else if (filename.includes(scope.locale)) {
                            // Move constant files into locale specific directories
                            filename = `${scope.locale}/${filename}`
                        }

                        outPath = ppath.join(outDir, filename)
                        let ref = addEntry(outPath, outDir, scope.templates)
                        if (ref) {
                            // This is a new file
                            if (force || !await fs.pathExists(outPath)) {
                                feedback(FeedbackType.info, `Generating ${outPath}`)
                                let result = template
                                if (typeof template === 'object') {
                                    process.chdir(ppath.dirname(template.templates[0].source))
                                    result = template.evaluateTemplate('template', scope) as any as string
                                    if (Array.isArray(result)) {
                                        result = result.join('\n')
                                    }
                                }

                                // See if generated file has been overridden in templates
                                let existing = await findTemplate(filename, templateDirs)
                                if (existing) {
                                    result = existing
                                }

                                let dir = ppath.dirname(outPath)
                                await fs.ensureDir(dir)
                                await fs.writeFile(outPath, result)
                                scope.templates[ppath.extname(outPath).substring(1)].push(ref)

                            } else {
                                feedback(FeedbackType.warning, `Skipping already existing ${outPath}`)
                            }
                        }
                    }

                    if (typeof template === 'object') {
                        if (template.templates.some(f => f.name === 'entities') && !scope.schema.properties[scope.property].$entities) {
                            let entities = template.evaluateTemplate('entities', scope) as any as string[]
                            if (entities) {
                                scope.schema.properties[scope.property].$entities = entities
                            }
                        }
                        if (template.templates.some(f => f.name === 'templates')) {
                            let generated = template.evaluateTemplate('templates', scope) as any as string[]
                            for (let generate of generated) {
                                await processTemplate(generate, templateDirs, outDir, scope, force, feedback, false)
                            }
                        }
                    }
                }
            } else if (!ignorable) {
                feedback(FeedbackType.error, `Missing template ${templateName}`)
            }
        }
    } catch (e) {
        feedback(FeedbackType.error, e.message)
    } finally {
        process.chdir(oldDir)
    }
    return outPath
}

async function processTemplates(
    schema: s.Schema,
    templateDirs: string[],
    locales: string[],
    outDir: string,
    scope: any,
    force: boolean,
    feedback: Feedback): Promise<void> {
    scope.templates = {}
    for (let locale of locales) {
        scope.locale = locale
        for (let property of schema.schemaProperties()) {
            scope.property = property.path
            scope.type = property.typeName()
            let templates = property.schema.$templates
            if (!templates) {
                templates = [scope.type]
            }
            for (let template of templates) {
                await processTemplate(template, templateDirs, outDir, scope, force, feedback, false)
            }
            let entities = property.schema.$entities
            if (!entities) {
                feedback(FeedbackType.error, `${property.path} does not have $entities defined in schema or template.`)
            } else if (!property.schema.$templates) {
                for (let entity of entities) {
                    let [entityName, role] = entity.split(':')
                    scope.role = role
                    if (entityName === `${scope.property}Entity`) {
                        entityName = `${scope.type}`
                    }
                    await processTemplate(`${entityName}Entity-${scope.type}`, templateDirs, outDir, scope, force, feedback, false)
                }
            }
        }

        // Process templates found at the top
        if (schema.schema.$templates) {
            scope.entities = schema.entityTypes()
            for (let templateName of schema.schema.$templates) {
                await processTemplate(templateName, templateDirs, outDir, scope, force, feedback, false)
            }
        }
    }
}

// Expand strings with ${} expression in them by evaluating and then interpreting as JSON.
function expandSchema(schema: any, scope: any, path: string, inProperties: boolean, missingIsError: boolean, feedback: Feedback): any {
    let newSchema = schema
    if (Array.isArray(schema)) {
        newSchema = []
        for (let val of schema) {
            let newVal = expandSchema(val, scope, path, false, missingIsError, feedback)
            newSchema.push(newVal)
        }
    } else if (typeof schema === 'object') {
        newSchema = {}
        for (let [key, val] of Object.entries(schema)) {
            let newPath = path
            if (inProperties) {
                newPath += newPath === '' ? key : '.' + key
            }
            let newVal = expandSchema(val, { ...scope, property: newPath }, newPath, key === 'properties', missingIsError, feedback)
            newSchema[key] = newVal
        }
    } else if (typeof schema === 'string' && schema.startsWith('${')) {
        let expr = schema.substring(2, schema.length - 1)
        try {
            let { value, error } = expressionEngine.parse(expr).tryEvaluate(scope)
            if (!error && value) {
                newSchema = value
            } else {
                if (missingIsError) {
                    feedback(FeedbackType.error, `${expr}: ${error}`)
                }
            }
        } catch (e) {
            feedback(FeedbackType.error, `${expr}: ${e.message}`)
        }
    }
    return newSchema
}

function expandStandard(dirs: string[]): string[] {
    let expanded: string[] = []
    for (let dir of dirs) {
        if (dir === 'standard') {
            dir = ppath.join(__dirname, '../../templates')
        }
        expanded.push(dir)
    }
    return expanded
}


/**
 * Iterate through the locale templates and generate per property/locale files.
 * Each template file will map to <filename>_<property>.<ext>.
 * @param schemaPath Path to JSON Schema to use for generation.
 * @param prefix Prefix to use for generated files.
 * @param outDir Where to put generated files.
 * @param metaSchema Schema to use when generating .dialog files
 * @param allLocales Locales to generate.
 * @param templateDirs Where templates are found.
 * @param force True to force overwriting existing files.
 * @param feedback Callback function for progress and errors.
 */
export async function generate(
    schemaPath: string,
    prefix?: string,
    outDir?: string,
    metaSchema?: string,
    allLocales?: string[],
    templateDirs?: string[],
    force?: boolean,
    feedback?: Feedback)
    : Promise<void> {

    if (!feedback) {
        feedback = (_info, _message) => true
    }

    if (!prefix) {
        prefix = ppath.basename(schemaPath, '.schema')
    }

    if (!outDir) {
        outDir = ppath.join(prefix + '-resources')
    }

    if (!metaSchema) {
        metaSchema = 'https://raw.githubusercontent.com/microsoft/botbuilder-dotnet/master/schemas/sdk.schema'
    } else if (!metaSchema.startsWith('http')) {
        // Adjust relative to outDir
        metaSchema = ppath.relative(outDir, metaSchema)
    }

    if (!allLocales) {
        allLocales = ['en-us']
    }

    if (!templateDirs) {
        templateDirs = ['standard']
    }

    let op = 'Regenerating'
    if (!force) {
        force = false
        op = 'Generating'
    }
    feedback(FeedbackType.message, `${op} resources for ${ppath.basename(schemaPath, '.schema')} in ${outDir}`)
    feedback(FeedbackType.message, `Locales: ${JSON.stringify(allLocales)} `)
    feedback(FeedbackType.message, `Templates: ${JSON.stringify(templateDirs)} `)
    feedback(FeedbackType.message, `App.schema: ${metaSchema} `)
    try {
        templateDirs = expandStandard(templateDirs)
        await fs.ensureDir(outDir)
        let schema = await processSchemas(schemaPath, templateDirs, feedback)
        schema.schema = expandSchema(schema.schema, {}, '', false, false, feedback)

        // Process templates
        let scope: any = {
            locales: allLocales,
            prefix: prefix || schema.name(),
            schema: schema.schema,
            properties: schema.schema.$public,
            triggerIntent: schema.triggerIntent(),
            appSchema: metaSchema
        }
        await processTemplates(schema, templateDirs, allLocales, outDir, scope, force, feedback)

        // Expand schema expressions
        let expanded = expandSchema(schema.schema, scope, '', false, true, feedback)

        // Write final schema
        let body = JSON.stringify(expanded, (key, val) => (key === '$templates' || key === '$requires') ? undefined : val, 4)
        await writeFile(ppath.join(outDir, `${prefix}.schema.dialog`), body, force, feedback)
    } catch (e) {
        feedback(FeedbackType.error, e.message)
    }
}
