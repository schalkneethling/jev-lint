; What jev-lint extracts from JavaScript and TypeScript. The TypeScript and TSX grammars extend the
; JavaScript one, so this file serves all three. Supporting another language means another grammar
; and another file with these same capture names; the rules never see a syntax tree.
;
;   @function + @function.name + @function.body   a named function and its body
;   @test + @test.title + @test.body              a test case and its callback
;   @catch + @catch.body                          a catch clause and its block
;   @comment                                      every comment; adjacency is resolved in code

(function_declaration
  name: (identifier) @function.name
  body: (statement_block) @function.body) @function

(generator_function_declaration
  name: (identifier) @function.name
  body: (statement_block) @function.body) @function

(method_definition
  name: (property_identifier) @function.name
  body: (statement_block) @function.body
  (#not-eq? @function.name "constructor")) @function

(variable_declarator
  name: (identifier) @function.name
  value: [
    (arrow_function body: (_) @function.body)
    (function_expression body: (statement_block) @function.body)
  ]) @function

(call_expression
  function: [
    (identifier) @_runner
    (member_expression object: (identifier) @_runner)
  ]
  arguments: (arguments
    .
    [(string) (template_string)] @test.title
    [(arrow_function) (function_expression)] @test.body)
  (#any-of? @_runner "it" "test")) @test

(try_statement
  body: (statement_block) @catch.try
  handler: (catch_clause body: (statement_block) @catch.body) @catch)

(comment) @comment
